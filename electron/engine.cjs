const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { nvidiaInfo, cudaRuntimeEnv } = require('./nvidia.cjs');
const { command, waitForPreviousCommands } = require('./install-command.cjs');
const comfySource = require('./engine-source.cjs');

const REF = 'v0.3.68';
const REVISION = '265adad858e1f31b66cd3523a02b16f5d34ced52';
const UV = '0.9.11';
const PYTHON = '3.12.12';
const TORCH = { torch: '2.8.0', torchvision: '0.23.0', torchaudio: '2.8.0' };
const CUDA_TORCH_TAG = '+cu128';
const CUDA_INDEX = 'https://download.pytorch.org/whl/cu128';
const CUDA_REPAIR_WHEELS = [
  'https://download-r2.pytorch.org/whl/cu128/torch-2.8.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=0ad925202387f4e7314302a1b4f8860fa824357f9b1466d7992bf276370ebcff',
  'https://download-r2.pytorch.org/whl/cu128/torchvision-0.23.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=20fa9c7362a006776630b00b8a01919fedcf504a202b81358d32c5aef39956fe',
  'https://download-r2.pytorch.org/whl/cu128/torchaudio-2.8.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=cce3a60cd9a97f7360c8f95504ac349311fb7d6b9b826135936764f4de5f782d',
];
const GIB = 1024 ** 3;
const windows = process.platform === 'win32';
const installers = {
  'darwin-arm64': {
    backend: 'MPS',
    archive: `uv-${UV}-py3-none-macosx_11_0_arm64.whl`,
    baseUrl: 'https://files.pythonhosted.org/packages/bf/f3/6b9fac39e5b65fa47dba872dcf171f1470490cd645343e8334f20f73885b/',
    size: 18380643, sha256: '48548a23fb5a103b8955dfafff7d79d21112b8e25ce5ff25e3468dc541b20e83', estimated: 2 * GIB,
  },
  'win32-x64': {
    backend: 'CUDA',
    archive: `uv-${UV}-py3-none-win_amd64.whl`,
    baseUrl: 'https://files.pythonhosted.org/packages/2c/2f/d51c02627de68a7ca5b82f0a5d61d753beee3fe696366d1a1c5d5e40cd58/',
    size: 21626822, sha256: 'c65a024ad98547e32168f3a52360fe73ff39cd609a8fb9dd2509aac91483cfc8', estimated: 6 * GIB,
  },
};

const target = installers[`${process.platform}-${process.arch}`];
const sourceArchive = { size: 6797749, sha256: '282bcf361340910b4bc6ca79700c3b00630ca6fa63d80c412e8eab7f659edd43' };
const sourceUrl = `https://codeload.github.com/Comfy-Org/ComfyUI/tar.gz/${REVISION}`;
let installing;
let runtime;

function supported() {
  return Boolean(target);
}

async function gpuInfo() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { supported: true, backend: 'MPS', name: 'Apple 芯片' };
  if (windows && process.arch === 'x64') return nvidiaInfo();
  return { supported: false, name: '此设备请连接已有 ComfyUI 实例' };
}

async function info(dir) {
  const gpu = await gpuInfo();
  let available = null;
  const absolute = path.isAbsolute(dir || '');
  if (absolute) {
    let parent = dir;
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    try {
      const stat = await fs.promises.statfs(parent);
      available = stat.bavail * stat.bsize;
    } catch {}
  }
  const { canRepair, repairing, installed } = absolute ? await managedInstallation(dir) : {};
  const resumable = Boolean(absolute && target && !installed && (canRepair || hasRuntimeProgress(dir)));
  return {
    ...gpu, ref: REF, python: PYTHON, estimatedBytes: target?.estimated ?? null, availableBytes: available,
    installed: Boolean(installed), resumable, canRepair: Boolean(canRepair), repairing: Boolean(repairing),
  };
}

async function digest(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArtifact(url, file, partial, received, size, signal, emit) {
  const name = path.basename(file);
  const stalled = new AbortController();
  const idle = setTimeout(() => stalled.abort(new Error(`${name} 的下载连接已超时。请检查网络后重试，已下载的部分会保留。`)), 90000);
  const downloadSignal = AbortSignal.any([signal, stalled.signal, AbortSignal.timeout(2 * 60 * 60000)]);
  try {
    const response = await fetch(url, {
      headers: received ? { Range: `bytes=${received}-` } : {},
      signal: downloadSignal,
    });
    idle.refresh();
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} · ${name}`);
    const resuming = response.status === 206;
    if (resuming && !response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) {
      throw new Error('远端返回了不匹配的续传区间');
    }
    if (!resuming) received = 0;
    const length = Number(response.headers.get('content-length')) || 0;
    const total = size ?? (length ? length + received : null);
    let nextLog = 0;
    const stream = Readable.fromWeb(response.body);
    stream.on('data', chunk => {
      idle.refresh();
      received += chunk.length;
      if (total && received > total) stream.destroy(new Error('下载长度超过清单大小'));
      if (Date.now() > nextLog) {
        emit?.(`${name}：${(received / 1024 ** 2).toFixed(1)}${total ? ' / ' + (total / 1024 ** 2).toFixed(1) : ''} MB\n`);
        nextLog = Date.now() + 800;
      }
    });
    await pipeline(stream, fs.createWriteStream(partial, { flags: resuming ? 'a' : 'w' }), { signal: downloadSignal });
    return received;
  } catch (error) {
    signal.throwIfAborted();
    stalled.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(idle);
  }
}

async function fetchArtifact(url, file, { size, sha256 }, signal, emit) {
  if (new URL(url).protocol !== 'https:') throw new Error('下载地址必须使用 HTTPS');
  if (fs.existsSync(file)) {
    if ((!size || fs.statSync(file).size === size) && (!sha256 || await digest(file, signal) === sha256)) return file;
    throw new Error(`文件与清单不匹配，请移走该文件后重试：${file}`);
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const partial = file + '.part';
  let received = (await fs.promises.stat(partial).catch(() => null))?.size ?? 0;
  if (!size || received > size) received = 0;
  if (!size || received < size) {
    emit?.(`正在连接下载源，等待 ${path.basename(file)}\n`);
    received = await downloadArtifact(url, file, partial, received, size, signal, emit);
  }
  signal.throwIfAborted();
  if (size && received !== size) throw new Error('下载未结束，可重试续传');
  if (sha256 && await digest(partial, signal) !== sha256) {
    await fs.promises.rm(partial, { force: true });
    throw new Error(`SHA-256 校验失败：${path.basename(file)}`);
  }
  signal.throwIfAborted();
  await fs.promises.rename(partial, file);
  return file;
}

function workspace(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择完整的本地安装目录');
  return path.resolve(directory);
}

async function exclusive(directory, operation) {
  if (installing) throw new Error('已有本地引擎安装或下载任务');
  const controller = new AbortController();
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  installing = { controller, finished };
  try {
    await waitForPreviousCommands(directory, controller.signal);
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } catch (error) {
    controller.signal.throwIfAborted();
    if (['ENOSPC', 'EDQUOT'].includes(error.code) || /\(os error (28|112)\)/i.test(error.message)) {
      throw new Error('安装目录或系统临时目录空间不足，请释放空间后继续。\n' + error.message, { cause: error });
    }
    throw error;
  } finally {
    installing = null;
    finish();
  }
}

function pythonAt(directory) {
  return path.join(directory, '.venv', windows ? 'Scripts/python.exe' : 'bin/python');
}

function uvAt(directory) {
  return path.join(directory, '.uv', windows ? 'uv.exe' : 'uv');
}

function hasRuntimeProgress(directory) {
  const download = path.join(directory, '.downloads');
  const archives = [target.archive, REVISION + '.tar.gz'];
  return fs.existsSync(uvAt(directory)) || archives.some(name => {
    const file = path.join(download, name);
    return fs.existsSync(file) || fs.existsSync(file + '.part');
  });
}

const installationFile = directory => path.join(directory, 'installation.json');

async function readInstallation(directory) {
  try {
    return JSON.parse(await fs.promises.readFile(installationFile(directory), 'utf8'));
  } catch {
    return null;
  }
}

async function managedInstallation(directory) {
  const manifest = await readInstallation(directory);
  const canRepair = Boolean(target && manifest?.revision === REVISION && manifest?.python === PYTHON);
  if (!canRepair) return { canRepair, installed: false, repairing: false };
  const source = await comfySource.inspectSource(path.join(directory, 'ComfyUI'));
  const python = await fs.promises.stat(pythonAt(directory)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const complete = source.revision === REVISION && source.complete && python?.isFile() && python.size > 0;
  const repairing = manifest.state === 'repairing' || !complete;
  return { canRepair, installed: !repairing, repairing };
}

async function writeInstallation(directory, gpu, state) {
  const file = installationFile(directory);
  await fs.promises.writeFile(file + '.tmp', JSON.stringify({ ref: REF, revision: REVISION, python: PYTHON, gpu, state }));
  await fs.promises.rename(file + '.tmp', file);
}

function httpsSource(value, label) {
  if (value === undefined || typeof value === 'string' && !value.trim()) return '';
  try {
    const index = new URL(value.trim());
    if (index.protocol === 'https:' && !index.username && !index.password && !index.search && !index.hash) return index.href;
  } catch {}
  throw new Error(`请输入有效的 HTTPS ${label}地址`);
}

function downloadSources({ packageIndex, pythonMirror } = {}) {
  return {
    packageIndex: httpsSource(packageIndex, 'Python 包镜像'),
    pythonMirror: httpsSource(pythonMirror, 'Python 运行时镜像'),
  };
}

async function verifyAcceleration(python, root, backend, { signal, emit, env }) {
  const device = backend.toLowerCase();
  const lines = ['import torch'];
  if (backend === 'CUDA') lines.push('assert torch.version.cuda == "12.8", "PyTorch requires the CUDA 12.8 build"');
  lines.push(`assert torch.ones(1, device="${device}").add_(1).item() == 2, "GPU computation failed"`);
  emit?.(`验证 ${backend} 实际运算\n`);
  try {
    await command(python, ['-c', lines.join('\n')], root, { signal, emit, env });
  } catch (error) {
    signal?.throwIfAborted();
    const action = backend === 'CUDA' ? '检查 NVIDIA 驱动、显卡兼容性及安装日志' : '检查系统版本及安装日志';
    throw new Error(`${backend} 运算校验失败，请${action}\n${error.message}`, { cause: error });
  }
}

async function installRuntime(root, { packageIndex, pythonMirror, repairRuntime }, signal, emit, system) {
  if (!system.supported) throw new Error(system.name);
  if (runtime) throw new Error('请先停止本地引擎');
  const repair = Boolean(repairRuntime || system.repairing);
  if (repair && !system.canRepair) throw new Error('请选择已安装的受管引擎目录');
  if (!system.installed && !system.resumable && system.availableBytes !== null && system.availableBytes < target.estimated) {
    throw new Error('磁盘空间不足，请更换目录或清理空间');
  }
  await fs.promises.mkdir(root, { recursive: true });
  const download = path.join(root, '.downloads');
  const source = path.join(root, 'ComfyUI');
  if (repair) {
    await writeInstallation(root, system.name, 'repairing');
    signal.throwIfAborted();
    emit?.('恢复 ComfyUI 程序文件并修复 Python 依赖\n');
  }
  await comfySource.ensureComfySource(source, {
    revision: REVISION, repair, canRepair: system.canRepair, signal, emit,
    getArchive: () => fetchArtifact(sourceUrl, path.join(download, REVISION + '.tar.gz'), sourceArchive, signal, emit),
  });
  const uv = uvAt(root);
  if (!fs.existsSync(uv)) {
    const artifact = await fetchArtifact(target.baseUrl + target.archive,
      path.join(download, target.archive), target, signal, emit);
    const temporary = await fs.promises.mkdtemp(path.join(root, '.uv-extract-'));
    try {
      const member = `uv-${UV}.data/scripts/${path.basename(uv)}`;
      await command('tar', ['-xf', artifact, '-C', temporary, member], root, { signal, emit });
      const unpacked = path.join(temporary, member);
      await command(unpacked, ['--version'], root, { signal, emit });
      signal.throwIfAborted();
      await fs.promises.mkdir(path.dirname(uv), { recursive: true });
      await fs.promises.rename(unpacked, uv);
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  }
  const env = {
    ...process.env, UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(root, '.cache'),
    UV_NO_PROGRESS: '1', UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || '120',
    UV_HTTP_RETRIES: process.env.UV_HTTP_RETRIES || '4',
    ...(packageIndex ? { UV_DEFAULT_INDEX: packageIndex } : {}),
    ...(pythonMirror ? { UV_PYTHON_INSTALL_MIRROR: pythonMirror } : {}),
  };
  const uvOptions = { signal, env, emit };
  emit?.(`安装 Python ${PYTHON}\n`);
  await command(uv, ['python', 'install', '--no-bin', '--no-registry', ...(repair ? ['--reinstall'] : []), PYTHON], root, uvOptions);
  const python = pythonAt(root);
  if (repair || !fs.existsSync(python)) {
    await command(uv, ['venv', '--allow-existing', '--managed-python', '--python', PYTHON, path.join(root, '.venv')], root, uvOptions);
  }
  const pipArgs = ['pip', 'install', '--python', python];
  const torchRequirements = Object.entries(TORCH).map(([name, version]) =>
    `${name}==${version}${windows ? CUDA_TORCH_TAG : ''}`);
  // uv 0.9.11 splits a constraint path containing spaces even when it receives one argument.
  const constraints = '.torch-constraints.txt';
  await fs.promises.writeFile(path.join(root, constraints), [...torchRequirements, 'transformers<5'].join('\n') + '\n');
  emit?.('安装 PyTorch 和 ComfyUI 依赖\n');
  if (windows && !repair) {
    await command(uv, [...pipArgs, '--default-index', CUDA_INDEX, ...torchRequirements], root, uvOptions);
  }
  // Direct wheel URLs keep CUDA packages available during forced dependency resolution against the configured mirror.
  await command(uv, [
    ...pipArgs, ...(repair ? ['--reinstall', ...(windows ? CUDA_REPAIR_WHEELS : [])] : []),
    '-c', constraints, '-r', path.join('ComfyUI', 'requirements.txt'),
  ], root, uvOptions);
  await verifyAcceleration(python, root, system.backend, { signal, emit, env: cudaRuntimeEnv(system) });
  signal.throwIfAborted();
  await writeInstallation(root, system.name);
  return { dir: root, ref: REF };
}

async function install(directory, emit, options) {
  const root = workspace(directory);
  const sources = downloadSources(options);
  return exclusive(root, async signal => installRuntime(root, sources, signal, emit, await info(root)));
}

const modelFolders = new Set(['checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'clip_vision', 'loras', 'upscale_models', 'controlnet', 'embeddings']);

function validateModels(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 50) throw new Error('模型清单必须包含 1 至 50 项');
  const seen = new Set();
  for (const item of entries) {
    if (!modelFolders.has(item?.folder) || typeof item.name !== 'string' ||
        !/^[\p{L}\p{N}_. -]+\.(safetensors|pt|pth|bin|gguf|ckpt)$/iu.test(item.name) ||
        item.name.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(item.name) ||
        typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 1 || new URL(item.url).protocol !== 'https:') {
      throw new Error('模型清单需要 HTTPS 地址、文件名、模型目录、字节数和 SHA-256');
    }
    const key = (item.folder + '/' + item.name).toLowerCase();
    if (seen.has(key)) throw new Error('清单包含重复模型文件');
    seen.add(key);
  }
  return entries.map(item => ({ ...item, sha256: item.sha256.toLowerCase() }));
}

async function installModels(directory, entries, emit) {
  const root = workspace(directory);
  const models = validateModels(entries);
  if (!fs.existsSync(path.join(root, 'installation.json'))) throw new Error('请先安装本地引擎');
  return exclusive(root, async signal => {
    const system = await info(root);
    if (!system.installed) throw new Error('请先完成本地引擎安装或修复，再下载模型');
    return installModelFiles(root, models, signal, emit, system);
  });
}

function modelFile(root, item) {
  return path.join(root, 'ComfyUI', 'models', item.folder, item.name);
}

function modelDownloadBytes(directory, models) {
  const root = workspace(directory);
  return models.reduce((bytes, item) => {
    const file = modelFile(root, item);
    const current = fs.statSync(file, { throwIfNoEntry: false });
    if (current?.isFile() && current.size === item.size) return bytes;
    const partial = fs.statSync(file + '.part', { throwIfNoEntry: false });
    const retained = partial?.isFile() && partial.size <= item.size ? partial.size : 0;
    return bytes + item.size - retained;
  }, 0);
}

async function installModelFiles(root, models, signal, emit, system) {
  if (system.availableBytes !== null && system.availableBytes < modelDownloadBytes(root, models)) {
    throw new Error('可用空间不足以保存模型');
  }
  for (const item of models) {
    signal.throwIfAborted();
    emit?.(`下载或校验模型 ${item.name}\n`);
    await fetchArtifact(item.url, modelFile(root, item), item, signal, emit);
  }
  return { count: models.length };
}

async function setup(directory, entries, emit, options) {
  const root = workspace(directory);
  const sources = downloadSources(options);
  const models = entries.length ? validateModels(entries) : [];
  return exclusive(root, async signal => {
    const system = await info(root);
    if (!system.supported) throw new Error(system.name);
    if (runtime && runtime.dir !== root) throw new Error('请先停止其他安装目录中的本地引擎');
    const needed = (system.installed || system.resumable ? 0 : system.estimatedBytes) + modelDownloadBytes(root, models);
    if (system.availableBytes !== null && system.availableBytes < needed) {
      throw new Error('所选目录空间不足，请更换目录或减少所选模型');
    }
    if (!system.installed || options?.repairRuntime) {
      await installRuntime(root, { ...sources, repairRuntime: options?.repairRuntime }, signal, emit, system);
    } else emit?.('已检测到可复用的本地引擎\n');
    signal.throwIfAborted();
    if (models.length) await installModelFiles(root, models, signal, emit, await info(root));
    signal.throwIfAborted();
    return { dir: root, ref: REF };
  });
}

function pause() {
  if (!installing) return false;
  installing.controller.abort(new Error('下载或安装已暂停，可以重试'));
  return true;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function installExtensions(root) {
  const directory = path.join(root, 'ComfyUI', 'custom_nodes');
  await fs.promises.mkdir(directory, { recursive: true });
  const extensions = ['imodureel_comfy_recovery.py'];
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    extensions.push('imodureel_mps_upscale.py', 'imodureel_mps_ltxv.py');
  }
  for (const name of extensions) {
    const source = await fs.promises.readFile(path.join(__dirname, name));
    const file = path.join(directory, name);
    const previous = await fs.promises.readFile(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous?.equals(source)) continue;
    await fs.promises.writeFile(file + '.tmp', source);
    await fs.promises.rename(file + '.tmp', file);
  }
}

const completionsDirectory = root => path.join(root, '.completed-prompts');
function completionFile(root, promptId) {
  if (!root || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(promptId)) return null;
  return path.join(completionsDirectory(root), promptId + '.json');
}

function completedPromptOutputs(root, promptId) {
  const file = completionFile(root, promptId);
  if (!file) return null;
  try {
    const files = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(files) ? { completed: { files } } : null;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Unable to read saved ComfyUI outputs:', error.message);
    return null;
  }
}

async function forgetPromptCompletion(root, promptId) {
  const file = completionFile(root, promptId);
  if (file) await fs.promises.rm(file, { force: true }).catch(() => {});
}

function stopInstance(instance) {
  instance.stop = true;
  instance.child?.stdin.end();
  instance.child?.kill();
  return instance.finished;
}

async function start(directory, emit) {
  const root = workspace(directory);
  if (!target) throw new Error('此设备请连接已有 ComfyUI 实例');
  if (installing) throw new Error('请等待本地安装完成');
  if (!fs.existsSync(installationFile(root))) throw new Error('引擎尚未安装');
  if (runtime) {
    if (runtime.stop) {
      await runtime.finished;
      return start(root, emit);
    }
    if (runtime.dir !== root) throw new Error('请先停止其他安装目录中的本地引擎');
    return runtime.ready;
  }
  const instance = { dir: root, stop: false };
  let resolveFinished;
  instance.finished = new Promise(resolve => { resolveFinished = resolve; });
  function finish() {
    if (runtime === instance) runtime = null;
    resolveFinished();
  }
  runtime = instance;
  instance.ready = (async () => {
    const system = await managedInstallation(root);
    if (!system.canRepair) throw new Error('本地引擎安装记录无效或版本不匹配，请检查安装目录');
    if (system.repairing) throw new Error('本地引擎修复尚未完成，请在设置中继续修复');
    const gpu = await gpuInfo();
    if (!gpu.supported) throw new Error(gpu.name);
    await installExtensions(root);
    const bootstrap = await fs.promises.readFile(path.join(__dirname, 'imodureel_comfy_bootstrap.py'), 'utf8');
    const gpuEnv = target.backend === 'CUDA' ? cudaRuntimeEnv(gpu) : process.env;
    const env = { ...gpuEnv, IMODUREEL_COMPLETED_PROMPTS: completionsDirectory(root) };
    const port = await availablePort();
    if (instance.stop) throw new Error('引擎启动已取消');
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(pythonAt(root), ['-u', '-c', bootstrap, 'main.py', '--listen', '127.0.0.1', '--port', String(port)], {
      cwd: path.join(root, 'ComfyUI'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    instance.child = child;
    let terminated = null;
    child.stdin.on('error', () => {});
    child.on('error', error => { terminated = error; });
    child.on('exit', code => { terminated = new Error(`本地引擎退出：${code}`); });
    child.on('close', () => {
      finish();
      if (!instance.stop) emit?.(terminated?.message + '\n');
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => emit?.(chunk.toString()));
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (terminated) throw terminated;
      if (instance.stop) throw new Error('引擎启动已取消');
      const stats = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(1000) })
        .then(response => response.ok ? response.json() : null).catch(() => null);
      if (stats?.system?.comfyui_version && !terminated && !instance.stop) {
        const devices = Array.isArray(stats.devices) ? stats.devices : [];
        if (target && !devices.some(device => device?.type === target.backend.toLowerCase())) {
          throw new Error(`本地 ComfyUI 未使用 ${target.backend} 加速，请检查引擎环境和启动日志`);
        }
        instance.url = url;
        return url;
      }
      await delay(500);
    }
    throw new Error('引擎未能在两分钟内就绪，请查看启动日志');
  })().catch(async error => {
    if (instance.child) await stopInstance(instance);
    else finish();
    throw error;
  });
  return instance.ready;
}

async function stop() {
  const installation = installing?.finished;
  pause();
  await Promise.all([installation, runtime && stopInstance(runtime)]);
}

function runningInstance() {
  return runtime?.url && !runtime.stop ? { url: runtime.url, dir: runtime.dir } : null;
}

module.exports = {
  supported, info, downloadSources, runningInstance, install, start, stop, pause, validateModels, installModels,
  setup, modelDownloadBytes, verifyAcceleration, completedPromptOutputs, forgetPromptCompletion, REF,
};
