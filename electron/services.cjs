const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { Worker } = require('node:worker_threads');
const store = require('./store.cjs');
const media = require('./media.cjs');
const { exportVideo } = require('./render-worker.cjs');
const { assetFileState, requireAssetFile, hasStorageFullMessage } = require('./asset-file.cjs');
const { shotSchema, shotDuration, maxLtxShotSeconds } = require('./templates.cjs');

const DEFAULT_COMFY = 'http://127.0.0.1:8188';
const workflowVariables = ['prompt', 'title', 'duration', 'dialogue', 'frameCount', 'seed', 'asset', 'productImage', 'referenceImage', 'sourceVideo'];
const assetVariables = new Set(['asset', 'productImage', 'referenceImage', 'sourceVideo']);
const text = { type: 'string' };
const names = { type: 'array', items: text };
const shotList = {
  type: 'array',
  minItems: 1,
  items: objectSchema({
    title: text,
    prompt: { ...text, minLength: 1, description: '独立可执行的画面和运镜描述' },
    duration: { type: 'number', minimum: shotDuration.min, maximum: maxLtxShotSeconds },
    dialogue: text,
    scene: text,
    characters: names,
  }),
};
const analysisSchema = objectSchema({
  summary: { ...text, minLength: 1 },
  characters: names,
  scenes: { type: 'array', items: objectSchema({ title: text, description: text }) },
  shots: shotList,
});
const productAppearanceSchema = objectSchema({
  color: { ...text, description: '参考图中商品主体的可见颜色' },
  shape: { ...text, description: '参考图中可见的轮廓、款式和剪裁' },
  texture: { ...text, description: '参考图中可见的纹理，无法判断时留空' },
});
const fashionAnalysisSchema = objectSchema({ productAppearance: productAppearanceSchema, ...analysisSchema.properties });
const revisionSchema = objectSchema({ shots: shotList });

const heifWorker = path.join(__dirname, 'heif-worker.cjs')
  .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

async function withPreparedMedia(action) {
  let temporary;
  const prepare = async originalSource => {
    let src = originalSource;
    if (/\.hei[cf]$/i.test(originalSource)) {
      temporary ??= await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-heif-'));
      src = path.join(temporary, store.id() + '.png');
      await new Promise((resolve, reject) => {
        const worker = new Worker(heifWorker, { workerData: { source: originalSource, output: src } });
        worker.once('message', ({ code, message }) => reject(Object.assign(new Error(message), { code })));
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error('无法解码 HEIC/HEIF 主图')));
      });
    }
    return { src, originalSource, name: path.basename(originalSource), ...await media.probe(src) };
  };
  try {
    return await action(prepare);
  } finally {
    if (temporary) await fs.promises.rm(temporary, { force: true, recursive: true, maxRetries: 4 }).catch(() => {});
  }
}

async function importMedia(projectId, paths) {
  store.editableProject(projectId);
  const errors = new Map();
  const results = [];
  const descriptions = {
    UNREADABLE_MEDIA: '无法读取或识别媒体格式',
    ENOENT: '找不到文件',
    EACCES: '没有读取或写入权限',
    EPERM: '没有读取或写入权限',
    ENOSPC: '项目磁盘可用空间不足',
  };
  const reject = (source, error) => errors.set(source, descriptions[error.code] ?? error.message);
  return withPreparedMedia(async prepare => {
    for (const file of paths) {
      try {
        results.push(await prepare(file));
      } catch (error) {
        reject(file, error);
      }
    }
    const imported = results.length ? await store.addMedia(projectId, results, undefined, (entry, error) => reject(entry.originalSource, error)) : [];
    const failed = paths.filter(file => errors.has(file)).map(file => ({ name: path.basename(file), reason: errors.get(file) }));
    return { imported, failed };
  });
}

function relinkMedia(assetId, file) {
  return withPreparedMedia(async prepare => {
    const media = await prepare(file);
    return store.relinkAsset(assetId, media.src, media);
  });
}

function objectSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function baseUrl(value = DEFAULT_COMFY) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入有效的 HTTP(S) 服务地址');
  }
  return url.href.replace(/\/$/, '');
}

class ServiceError extends Error {
  constructor(route, status, detail) {
    let payload;
    if (status === 400) {
      try { payload = JSON.parse(detail); } catch {}
    }
    const errors = route === '/prompt' && isRecord(payload?.node_errors) ? Object.entries(payload.node_errors)
      .flatMap(([id, node]) => (Array.isArray(node?.errors) ? node.errors : []).map(problem => {
        const input = problem?.extra_info?.input_name;
        const label = `${id}${input ? '.' + input : ''}${node.class_type ? '（' + node.class_type + '）' : ''}`;
        return `${label} ${[problem?.message, problem?.details].filter(Boolean).join(' · ').slice(0, 320)}`;
      })) : [];
    const context = errors.length ? errors.slice(0, 6).join('\n') : detail?.slice(0, 1000);
    super(`${route}: HTTP ${status}${context ? ' · ' + context : ''}`);
    this.status = status;
    this.apiCode = payload?.error?.code;
  }
}

function isTemporaryConnectionFailure(error) {
  return [408, 429].includes(error.status) || error.status >= 500 ||
    error.name === 'TimeoutError' || error.name === 'TypeError' && error.message === 'fetch failed';
}

async function request(url, route, { signal, timeout = 30000, ...options } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(baseUrl(url) + route, {
    ...options, signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
  if (!response.ok) throw new ServiceError(route, response.status, await response.text());
  return response;
}

function post(body, signal) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
}

async function checkComfy(url, signal) {
  const nodes = await (await request(url, '/object_info', { signal })).json();
  if (!isRecord(nodes) || !Object.values(nodes).some(node => isRecord(node?.input))) {
    throw new Error('服务未返回有效的 ComfyUI 节点信息');
  }
  return { nodeCount: Object.keys(nodes).length };
}

async function hasMpsVideoNodes(url, types, signal) {
  try {
    const stats = await (await request(url, '/system_stats', { signal, timeout: 5000 })).json();
    if (!Array.isArray(stats?.devices) || !stats.devices.some(device => device?.type === 'mps')) return false;
    const nodes = await (await request(url, '/object_info', { signal })).json();
    return types.every(type => isRecord(nodes?.[type]?.input));
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateWorkflow(workflow, mapping = {}) {
  if (!isRecord(workflow) || !Object.keys(workflow).length || Object.values(workflow).some(
    node => !isRecord(node) || typeof node.class_type !== 'string' || !node.class_type.trim() || !isRecord(node.inputs),
  )) throw new Error('请导入 ComfyUI API 格式 JSON，至少包含一个可执行节点');
  if (!isRecord(mapping)) throw new Error('工作流映射必须是 JSON 对象');
  const targets = new Set();
  for (const [name, target] of Object.entries(mapping)) {
    if (!workflowVariables.includes(name)) throw new Error(`不支持映射变量：${name}`);
    if (!isRecord(target) || typeof target.input !== 'string' || !Object.hasOwn(workflow, target.node) ||
        !Object.hasOwn(workflow[target.node].inputs, target.input)) {
      throw new Error(`映射 ${name} 指向不存在的节点输入`);
    }
    const key = JSON.stringify([String(target.node), target.input]);
    if (targets.has(key)) throw new Error('多个变量不能写入同一个节点输入');
    targets.add(key);
  }
  return true;
}

function buildPrompt(workflow, mapping, values, allowMissing = false) {
  validateWorkflow(workflow, mapping);
  const prompt = structuredClone(workflow);
  for (const [name, { node, input }] of Object.entries(mapping)) {
    const value = values[name];
    if (value === undefined) {
      if (allowMissing) continue;
      throw new Error(`工作流缺少输入：${name}`);
    }
    prompt[node].inputs[input] = value;
  }
  return prompt;
}

const numericInputs = new Set(['INT', 'FLOAT']);
const dynamicInputs = new Set(['COMFY_AUTOGROW_V3', 'COMFY_COMBODYNAMIC_V3', 'COMFY_MATCHTYPE_V3']);
const annotatedFileInputs = new Set(['LoadImage', 'LoadImageMask', 'LoadVideo', 'LoadImageOutput']);
const previewNodes = new Set(['PreviewImage', 'PreviewAudio']);

function numberInput(value, type) {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number') return type === 'INT' ? Math.trunc(value) : value;
  if (typeof value !== 'string') return NaN;
  const text = value.trim().replace(/(\d)_(?=\d)/g, '$1');
  const pattern = type === 'INT' ? /^[+-]?\d+$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  return pattern.test(text) ? Number(text) : NaN;
}

function linkTypesMatch(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || dynamicInputs.has(from) || dynamicInputs.has(to)) return true;
  const expected = to.split(',').map(type => type.trim());
  const received = from.split(',').map(type => type.trim());
  return expected.includes('*') || received.includes('*') || received.some(type => expected.includes(type));
}

function checkNodeInputs(id, workflow, info, deferred, issues, unavailable) {
  const node = workflow[id];
  const spec = info[node.class_type];
  const required = spec.input?.required ?? {};
  const optional = spec.input?.optional ?? {};
  // Custom nodes may override normal type and range checks on the server.
  const external = typeof spec.python_module === 'string' && spec.python_module.startsWith('custom_nodes.');
  const label = input => `${id}.${input}（${node.class_type}）`;
  for (const [input, definition] of Object.entries(required)) {
    if (!Object.hasOwn(node.inputs, input) && !dynamicInputs.has(definition?.[0])) issues.push(`${label(input)} 缺少必填输入`);
  }

  const dependencies = [];
  for (const [input, stored] of Object.entries(node.inputs)) {
    const definition = Object.hasOwn(required, input) ? required[input] : optional[input];
    const [type, metadata] = Array.isArray(definition) ? definition : [];
    const options = metadata ?? {};
    const binding = deferred.get(JSON.stringify([id, input]));
    if (binding) {
      if (assetVariables.has(binding) && typeof type === 'string' &&
          (numericInputs.has(type) || type === 'BOOLEAN' ||
            !external && !dynamicInputs.has(type) && !linkTypesMatch(type, 'STRING,COMBO'))) {
        issues.push(`${label(input)} 需要接收文件名，请将 ${binding} 映射到加载素材的输入`);
      }
      continue;
    }

    if (Array.isArray(stored)) {
      const [fromId, slot] = stored;
      if (!definition && typeof fromId !== 'string') continue;
      if (stored.length !== 2 || typeof fromId !== 'string' || !Number.isInteger(slot) || slot < 0) {
        issues.push(`${label(input)} 的连线格式不正确`);
        continue;
      }
      if (!Object.hasOwn(workflow, fromId)) {
        issues.push(`${label(input)} 引用了不存在的节点 ${fromId}`);
        continue;
      }
      const outputs = info[workflow[fromId].class_type].output;
      if (Array.isArray(outputs) && slot >= outputs.length) {
        issues.push(`${label(input)} 引用了不存在的输出口 ${fromId}[${slot}]`);
        continue;
      }
      if (!external && !options.rawLink && !linkTypesMatch(outputs?.[slot], type)) {
        issues.push(`${label(input)} 需要 ${type}，但节点 ${fromId} 输出 ${outputs[slot]}`);
      }
      dependencies.push(fromId);
      continue;
    }

    const value = isRecord(stored) && Object.hasOwn(stored, '__value__') ? stored.__value__ : stored;
    if (numericInputs.has(type)) {
      const number = numberInput(value, type);
      if (!Number.isFinite(number)) issues.push(`${label(input)} 需要有效的 ${type} 数值`);
      else if (!external && ((Number.isFinite(options.min) && number < options.min) ||
          (Number.isFinite(options.max) && number > options.max))) {
        issues.push(`${label(input)} 的值 ${number} 超出范围（${options.min ?? '无下限'} 至 ${options.max ?? '无上限'}）`);
      }
    }
    const choices = Array.isArray(type) ? type : type === 'COMBO' ? options.options : undefined;
    if (!Array.isArray(choices) || choices.includes(value)) continue;
    if (annotatedFileInputs.has(node.class_type) && typeof value === 'string' &&
        (choices.includes(value.replace(/ \[input\]$/, '')) || / \[(?:output|temp)\]$/.test(value))) continue;
    unavailable.push({ node: id, input, value });
  }
  return dependencies;
}

async function preflight(url, workflow, mapping, { signal, defer = Object.keys(mapping) } = {}) {
  validateWorkflow(workflow, mapping);
  const info = await (await request(url, '/object_info', { signal })).json();
  if (!isRecord(info)) throw new Error('服务未返回有效的 ComfyUI 节点信息');
  const entries = Object.entries(workflow);
  const missing = [...new Set(entries.map(([, node]) => node.class_type).filter(type => !Object.hasOwn(info, type) || !isRecord(info[type])))];
  if (missing.length) throw new Error('实例缺少节点：' + missing.join('、'));

  const outputs = entries.filter(([, node]) => info[node.class_type].output_node === true);
  const completeMetadata = entries.every(([, node]) => typeof info[node.class_type].output_node === 'boolean');
  if (completeMetadata && !outputs.length) throw new Error('工作流缺少输出节点，请添加保存媒体的节点');
  if (completeMetadata && outputs.every(([, node]) => previewNodes.has(node.class_type))) {
    throw new Error('工作流只包含临时预览输出，请添加保存媒体的节点');
  }
  const roots = completeMetadata ? outputs : entries;
  const pendingBindings = new Set(defer);
  const deferred = new Map(Object.entries(mapping).filter(([name]) => pendingBindings.has(name))
    .map(([name, target]) => [JSON.stringify([String(target.node), target.input]), name]));
  const issues = [];
  const unavailable = [];
  const visited = new Map();
  const pending = roots.map(([id]) => ({ id, leaving: false }));
  while (pending.length) {
    const { id, leaving } = pending.pop();
    if (leaving) {
      visited.set(id, 'done');
      continue;
    }
    if (visited.has(id)) {
      if (visited.get(id) === 'visiting') issues.push(`节点 ${id} 位于循环连线中`);
      continue;
    }
    visited.set(id, 'visiting');
    const dependencies = checkNodeInputs(id, workflow, info, deferred, issues, unavailable);
    pending.push({ id, leaving: true });
    for (const source of dependencies) pending.push({ id: source, leaving: false });
  }
  for (const [name, { node, input }] of Object.entries(mapping)) {
    if (!visited.has(String(node))) issues.push(`映射 ${name} 的 ${node}.${input} 未连接到输出节点`);
  }
  if (issues.length) throw new Error('工作流预检失败\n' + issues.slice(0, 8).join('\n'));
  if (unavailable.length) {
    const fields = unavailable.slice(0, 8).map(({ node, input, value }) =>
      `${node}.${input} = ${(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200)}`);
    throw Object.assign(new Error('实例缺少模型、输入文件或其他选项：' + fields.join('、')), { unavailable });
  }
  return true;
}

async function uploadAsset(url, asset, jobId, signal) {
  const file = asset.path;
  const normalize = asset.kind === 'video' && (await media.probe(file, signal)).rotation % 360 !== 0;
  const temporary = normalize ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-rotate-')) : null;
  try {
    const filename = normalize ? path.basename(file, path.extname(file)) + '.mp4' : path.basename(file);
    const source = temporary ? path.join(temporary, filename) : file;
    if (temporary) await media.normalizeVideoRotation(file, source, signal);
    const form = new FormData();
    // Video loaders on older ComfyUI versions list the input root only.
    form.append('image', await fs.openAsBlob(source), jobId + '-' + filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const result = await (await request(url, '/upload/image', { method: 'POST', body: form, signal, timeout: 20 * 60000 })).json();
    if (typeof result.name !== 'string' || !result.name) throw new Error('ComfyUI 未返回上传文件名');
    return [result.subfolder, result.name].filter(Boolean).join('/');
  } finally {
    if (temporary) await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

async function submit(url, workflow, mapping, values, { signal, promptId } = {}) {
  const prompt = buildPrompt(workflow, mapping, values);
  await preflight(url, prompt, {}, { signal });
  return submitPrepared(url, prompt, { signal, promptId });
}

async function submitPrepared(url, prompt, { signal, promptId, keepOutputs } = {}) {
  const body = { prompt, client_id: promptId || store.id(), prompt_id: promptId };
  if (keepOutputs) body.extra_data = { imodureel_keep_outputs: true };
  const result = await (await request(url, '/prompt', post(body, signal))).json();
  if (result.error) throw new ServiceError('/prompt', 400, JSON.stringify(result));
  if (!result.prompt_id) throw new Error('ComfyUI 未接受任务');
  return result;
}

function observeComfyProgress(url, clientId, promptId, onProgress) {
  if (typeof WebSocket === 'undefined') return () => {};
  const endpoint = new URL(baseUrl(url) + '/ws');
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('clientId', clientId);
  let socket;
  let reconnect;
  let closed = false;

  function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(endpoint);
    } catch {
      return;
    }
    socket.addEventListener('message', event => {
      if (closed || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); }
      catch { return; }
      const data = message?.data;
      if (message?.type !== 'progress' || !data || !promptId() || data.prompt_id !== promptId() ||
          !Number.isFinite(data.value) || !Number.isFinite(data.max) || data.max <= 0) return;
      onProgress({
        node: String(data.node ?? ''), value: Math.max(0, Math.min(data.max, data.value)), max: data.max,
      });
    });
    socket.addEventListener('close', () => {
      if (!closed) reconnect = setTimeout(connect, 5000);
    }, { once: true });
  }

  connect();
  return () => {
    closed = true;
    clearTimeout(reconnect);
    if (socket?.readyState < WebSocket.CLOSING) socket.close();
  };
}

async function queueState(url, promptId, signal, matchClientId = false) {
  const queue = await (await request(url, '/queue', { signal })).json();
  const matches = entry => typeof entry?.[1] === 'string' && entry[1] &&
    (entry[1] === promptId || matchClientId && entry[3]?.client_id === promptId);
  const running = queue.queue_running?.find(matches);
  if (running) return { promptId: running[1], state: 'running' };
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.slice() : [];
  const index = pending.sort((a, b) => a[0] - b[0]).findIndex(matches);
  return index >= 0 ? { promptId: pending[index][1], state: 'queued', position: index + 1 } : null;
}

async function findPrompt(url, promptId, { signal, matchClientId = false } = {}) {
  const saved = await (await request(url, '/history/' + encodeURIComponent(promptId), { signal })).json();
  if (isRecord(saved) && Object.hasOwn(saved, promptId) && isRecord(saved[promptId])) return { promptId, history: saved[promptId] };
  const queued = await queueState(url, promptId, signal, matchClientId);
  if (queued || !matchClientId) return queued;
  // Older servers generate their own prompt ID but keep client_id in the submitted record.
  const recent = await (await request(url, '/history?max_items=50', { signal })).json();
  if (!isRecord(recent)) return null;
  const match = Object.entries(recent).find(([id, item]) => item?.prompt?.[1] === id && item.prompt[3]?.client_id === promptId);
  return match ? { promptId: match[0], history: match[1] } : null;
}

function promptFailure(messages) {
  const error = Array.isArray(messages) && messages.findLast(entry =>
    Array.isArray(entry) && ['execution_error', 'execution_interrupted'].includes(entry[0]));
  if (!error) return 'ComfyUI 运行失败，请查看实例日志';
  const [kind, details] = error;
  if (kind === 'execution_interrupted') return 'ComfyUI 已中断任务（execution_interrupted）';
  const reason = String(details?.exception_message || details?.exception_type || '').trim().slice(0, 500);
  if (hasStorageFullMessage(reason)) return 'ComfyUI 所在磁盘的空间不足。请释放该实例的磁盘空间，再重试生成。';
  if (details?.node_type === 'ImageUpscaleWithModel' && /view size.*stride/i.test(reason)) {
    return '当前 ComfyUI 的放大节点无法处理该素材的分块。可使用应用的受管本地引擎，或更新外部实例后重试。';
  }
  return [details?.node_type || 'ComfyUI 运行失败', reason].filter(Boolean).join(' · ');
}

async function waitPrompt(url, promptId, { signal, onStatus, onAccepted, poll = 1800, isManagedEngineRunning } = {}) {
  let unavailableSince = null;
  let missingCount = 0;
  while (!signal?.aborted) {
    let record;
    try {
      record = await findPrompt(url, promptId, { signal, matchClientId: Boolean(onAccepted) });
      unavailableSince = null;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.status && !isTemporaryConnectionFailure(error)) {
        if (!onAccepted) throw error;
        throw Object.assign(new Error('暂时无法核对原任务的服务端编号，请确认应用可查询原实例的任务记录。' + error.message, { cause: error }),
          { code: 'COMFY_DISCONNECTED' });
      }
      unavailableSince ??= Date.now();
      // A live local process can stop servicing HTTP while loading a large model.
      const waitingForLocalEngine = error.name === 'TimeoutError' && isManagedEngineRunning?.();
      const outageLimit = waitingForLocalEngine ? 300000 : 60000;
      if (Date.now() - unavailableSince > outageLimit) {
        const disconnected = new Error('ComfyUI 已断开。实例恢复后可继续跟踪原任务。');
        disconnected.code = 'COMFY_DISCONNECTED';
        throw disconnected;
      }
      await onStatus?.({ state: 'reconnecting' });
      await delay(poll, null, { signal });
      continue;
    }
    if (record && onAccepted) {
      await onAccepted(record.promptId);
      promptId = record.promptId;
      onAccepted = undefined;
    }
    const history = record?.history;
    if (history?.status?.status_str === 'error') throw new Error(promptFailure(history.status.messages));
    if (history?.status?.completed || history?.status?.status_str === 'success') return history.outputs || {};
    if (record) {
      missingCount = 0;
      await onStatus?.({ state: record.state ?? 'running', ...(record.position !== undefined && { position: record.position }) });
    } else if (++missingCount >= 5) {
      const error = new Error(onAccepted
        ? '无法确认原实例是否接收了任务。请在原实例核对队列和历史后再重试。'
        : '实例的队列与历史中均找不到原任务，可以重试生成');
      error.code = 'COMFY_PROMPT_MISSING';
      throw error;
    }
    await delay(poll, null, { signal });
  }
  signal?.throwIfAborted();
}

async function cancelPrompt(url, promptId, { waitForStop = false } = {}) {
  await request(url, '/queue', post({ delete: [promptId] }));
  const queued = await queueState(url, promptId);
  if (!queued) return true;
  if (queued.state === 'running') {
    const stats = await (await request(url, '/system_stats')).json();
    const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(stats.system?.comfyui_version || '');
    if (!version || +version[1] === 0 && (+version[2] < 3 || +version[2] === 3 && +version[3] < 68)) {
      throw new Error('该 ComfyUI 版本不支持按任务中断，请在 ComfyUI 中取消运行中的任务');
    }
    await request(url, '/interrupt', post({ prompt_id: promptId }));
  }
  if (!waitForStop) return false;
  const signal = AbortSignal.timeout(12000);
  try {
    while (await queueState(url, promptId, signal)) await delay(200, null, { signal });
    return true;
  } catch {
    // Preserve files if the server cannot confirm that the prompt has stopped.
    return false;
  }
}

async function downloadOutput(url, key, file, signal) {
  try {
    const response = await request(url, '/view?' + key, { signal, timeout: 20 * 60000 });
    if (!response.body) throw new Error('ComfyUI 返回了空文件');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file), { signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.status >= 500 || [408, 429].includes(error.status) ||
        ['TimeoutError', 'TypeError'].includes(error.name) || ['ECONNRESET', 'EPIPE'].includes(error.code)) {
      const disconnected = new Error('下载产物时与 ComfyUI 断开。实例恢复后可继续回收原任务的产物。', { cause: error });
      disconnected.code = 'COMFY_DISCONNECTED';
      throw disconnected;
    }
    throw error;
  }
}

function outputRecords(outputs) {
  const records = new Map();
  for (const node of Object.values(outputs || {})) {
    for (const items of Object.values(node || {})) {
      if (!Array.isArray(items)) continue;
      for (const file of items) {
        if (typeof file?.filename !== 'string' || !file.filename || file.type === 'temp') continue;
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
        records.set(String(query), file.filename);
      }
    }
  }
  return records;
}

async function collect(url, outputs, projectId, { jobId, kinds, signal, requireVisibleVideo = false } = {}) {
  const records = outputRecords(outputs);
  const registered = store.assets(projectId).filter(asset => asset.job_id === jobId);
  const existing = [];
  const missing = new Map();
  for (const asset of registered) {
    if (await assetFileState(asset, signal) === 'ready') existing.push(asset);
    else missing.set(asset.output_key, asset);
  }
  const recorded = new Set(existing.map(asset => asset.output_key));
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-output-'));
  try {
    const entries = [];
    let blackVideo = false;
    for (const [key, name] of records) {
      if (recorded.has(key)) continue;
      const source = path.join(temporary, store.id() + path.extname(name));
      await downloadOutput(url, key, source, signal);
      try {
        const details = await media.probe(source, signal);
        if (requireVisibleVideo && details.kind === 'video' && await media.isBlackVideo(source, signal)) {
          blackVideo = true;
          continue;
        }
        entries.push({ src: source, name, origin: 'comfy', ...details, jobId, outputKey: key, restoreId: missing.get(key)?.id });
        missing.delete(key);
      } catch (error) {
        if (error.code !== 'UNREADABLE_MEDIA') throw error;
      }
    }
    for (const asset of missing.values()) {
      await requireAssetFile(asset, signal);
      existing.push(asset);
    }
    signal?.throwIfAborted();
    const accepted = [...existing, ...entries];
    if (!accepted.length || kinds?.length && !accepted.some(asset => kinds.includes(asset.kind))) {
      const error = new Error(blackVideo
        ? '动态镜头所有帧均为黑色，请重试。如果使用 Apple MPS 上的外部 ComfyUI，可在生成引擎设置中导出并安装 MPS 兼容节点。'
        : `工作流未返回可用的${kinds?.includes('video') ? '视频' : '媒体'}产物，请检查保存节点`);
      error.code = 'COMFY_NO_OUTPUT';
      throw error;
    }
    return [...existing, ...(entries.length ? await store.addMedia(projectId, entries, signal) : [])];
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

class AnalysisOutputError extends Error {}

function cleanAnalysis(value) {
  if (!isRecord(value) || typeof value.summary !== 'string' || !Array.isArray(value.characters) ||
      !Array.isArray(value.scenes) || !Array.isArray(value.shots) || !value.shots.length) {
    throw new AnalysisOutputError('AI 返回格式不完整，需要摘要、角色、场次和分镜');
  }
  if (value.characters.some(item => typeof item !== 'string') ||
      value.scenes.some(item => typeof item?.title !== 'string' || typeof item.description !== 'string')) {
    throw new AnalysisOutputError('AI 返回的角色或场次格式不正确');
  }
  return {
    summary: value.summary, characters: value.characters, scenes: value.scenes,
    shots: cleanShots(value.shots),
  };
}

function normalizeProductAppearance(value) {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(productAppearanceSchema.required.map(field =>
    [field, typeof value[field] === 'string' ? value[field].trim() : '']));
}

function cleanShots(items) {
  if (!Array.isArray(items) || !items.length ||
      items.some(item => !isRecord(item) || typeof item.prompt !== 'string' || !item.prompt.trim())) {
    throw new AnalysisOutputError('AI 返回的分镜缺少画面描述，请调整输入后重试');
  }
  return store.normalizeShots(items.map(({ title, prompt, dialogue, scene, characters, duration }) => ({
    title, prompt, dialogue, scene, characters,
    duration: Number.isFinite(duration) && duration >= shotDuration.min && duration <= maxLtxShotSeconds
      ? duration : shotDuration.default,
  })));
}

function applyDialogueEvidence(shots, sources, transcript) {
  if (!sources || sources.script || sources.transcription === 'used') return shots;
  if (sources.transcription !== 'partial' || !transcript) {
    for (const shot of shots) shot.dialogue = '';
    return shots;
  }
  const spoken = value => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const known = transcript.split('\n').map(spoken);
  for (const shot of shots) {
    shot.dialogue = shot.dialogue.split('\n').filter(line => {
      const words = spoken(line);
      return words && known.some(text => text.includes(words));
    }).join('\n');
  }
  return shots;
}

function transcriptionSources(sources, result) {
  const { transcriptionProgress, ...rest } = sources;
  return { ...rest, transcription: result.status, ...(result.progress && { transcriptionProgress: result.progress }) };
}

function partialTranscriptInstruction(sources) {
  const progress = sources?.transcriptionProgress;
  if (sources?.transcription !== 'partial' || !progress) return '';
  return `语音转写共 ${progress.total} 段，缺少第 ${progress.missing.join('、')} 段。没有文字剧本时，只把已转写的原话用于对白。缺失部分的对白留空。`;
}

async function readAnalysisFrame(input, time, directory, index, signal, info) {
  const frame = path.join(directory, `frame-${index}.jpg`);
  const timestamp = await media.extractFrame(input, time, frame, signal, info);
  if (timestamp === null) return null;
  const image = await fs.promises.readFile(frame);
  return { timestamp, image: { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image.toString('base64') } } };
}

function referenceFrameTimes(cuts, duration) {
  const maxFrames = 12;
  if (cuts.length >= maxFrames) {
    return Array.from({ length: maxFrames }, (_, index) =>
      cuts[Math.round(index * (cuts.length - 1) / (maxFrames - 1))].start);
  }
  const times = cuts.map(cut => cut.start);
  if (!Number.isFinite(duration)) return times;
  // Fill long gaps even if a continuous shot produces no additional cuts.
  while (times.length < maxFrames) {
    let largestGap = 3;
    let midpoint;
    let position;
    for (let index = 0; index < times.length; index++) {
      const gap = (times[index + 1] ?? duration) - times[index];
      if (gap > largestGap) {
        largestGap = gap;
        position = index + 1;
        midpoint = times[index] + gap / 2;
      }
    }
    if (midpoint === undefined) break;
    times.splice(position, 0, midpoint);
  }
  return times;
}

async function analyze(config, template, inputs, { reference, productImage, signal, transcription } = {}) {
  if (!config?.url || !config?.apiKey || !config?.model) throw new Error('请先设置 AI 接口地址、密钥和模型');
  const content = [{ type: 'text', text: JSON.stringify(inputs) }];
  const temporary = config.vision && (reference || productImage)
    ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-analysis-'))
    : null;
  try {
    let sceneCuts = [];
    let referenceSources;
    let referenceTranscript;
    let instructions = template.analysisPrompt;
    let schema = analysisSchema;
    if (config.vision && productImage) {
      const frame = await readAnalysisFrame(productImage, 0, temporary, 0, signal);
      if (!frame) throw new Error('无法读取商品参考图，请重新选择图片');
      content.push({ type: 'text', text: '商品参考图，请根据可见款式完善卖点和分镜。' }, frame.image);
      content.push({ type: 'text', text: '将商品可见的颜色、款式和纹理写入 productAppearance，用于设计分镜。无法看清的属性留空。' });
      instructions += '返回 productAppearance 对象，包含 color、shape、texture 三个字符串。只描述参考图中商品主体实际可见的属性。';
      schema = fashionAnalysisSchema;
    }
    if (reference) {
      const details = await media.probe(reference, signal);
      const script = Boolean(inputs.script?.trim());
      const tryTranscription = details.audio && config.transcriptionEnabled !== false;
      const speech = tryTranscription
        ? await transcribeReference(config, reference, { ...transcription, signal, hasAlternative: config.vision || script })
        : { status: 'skipped', text: '' };
      const transcript = speech.text;
      if (!transcript && !config.vision && !script) {
        if (speech.status === 'unavailable') {
          throw new Error('当前语音转写接口或转写模型不可用。请检查转写配置、开启视觉分析或填写文字剧本。');
        }
        throw new Error('参考视频没有可用转写。请开启视觉分析、填写剧本或选择含有清晰对白的视频。');
      }
      const picture = await media.detectScenes(reference, details, signal);
      sceneCuts = picture.cuts;
      content[0].text += '\n检测到的镜头时间范围（秒）：' + JSON.stringify(sceneCuts);
      if (transcript) {
        referenceTranscript = transcript;
        content[0].text += '\n参考视频转写：' + transcript;
      }
      let frames = 0;
      if (config.vision && picture.lastFrame !== null) {
        const times = new Set(referenceFrameTimes(sceneCuts, picture.end).map(time => Math.min(time, picture.lastFrame)));
        let previous = -Infinity;
        for (const [index, time] of [...times].entries()) {
          if (time <= previous) continue;
          const frame = await readAnalysisFrame(reference, time, temporary, index + 1, signal, details);
          if (!frame || frame.timestamp <= previous) continue;
          previous = frame.timestamp;
          frames++;
          content.push({ type: 'text', text: `时间 ${frame.timestamp.toFixed(2)} 秒` }, frame.image);
        }
      }
      if (!frames && !transcript && !script) throw new Error('参考视频没有可抽取的画面，请检查视频或填写文字剧本。');
      if (frames) {
        content.push({ type: 'text', text: '把画面中可见的主体、颜色和变化写入 summary 和 scenes，按时间整理到 shots。以画面、剧本和转写为依据。没有可见人物或对白时，对应字段留空。' });
      }
      referenceSources = transcriptionSources({ script, frames }, speech);
      const partial = partialTranscriptInstruction(referenceSources);
      if (partial) content[0].text += '\n' + partial;
    }
    const analysis = await requestAnalysis(config, instructions, content.length === 1 ? content[0].text : content,
      'project_analysis', schema, signal, decoded => {
        const result = cleanAnalysis(decoded);
        if (schema === fashionAnalysisSchema) {
          const productAppearance = normalizeProductAppearance(decoded.productAppearance);
          if (!productAppearance) throw new AnalysisOutputError('AI 返回的商品分析缺少外观信息');
          result.productAppearance = productAppearance;
        }
        return result;
      });
    applyDialogueEvidence(analysis.shots, referenceSources, referenceTranscript);
    return { ...analysis, sceneCuts, ...(referenceSources && { referenceSources }), ...(referenceTranscript && { referenceTranscript }) };
  } finally {
    if (temporary) await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

function analysisExample(schema) {
  if (schema.type === 'object') {
    return Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, analysisExample(child)]));
  }
  if (schema.type === 'array') return schema.items.type === 'object' ? [analysisExample(schema.items)] : [];
  return schema.type === 'number' ? shotDuration.default : '';
}

async function requestAnalysis(config, prompt, content, name, schema, signal, validate) {
  if (!config?.url || !config?.apiKey || !config?.model) throw new Error('请先设置 AI 接口地址、密钥和模型');
  const instructions = prompt + `\n默认动态工作流的单镜头上限为 ${maxLtxShotSeconds} 秒。需要较长时长时拆成多个镜头。` +
    '请返回完整的 JSON 对象，shots 至少包含一个镜头。缺少出场角色或台词时对相应字段返回空数组或空字符串。';
  const example = JSON.stringify(analysisExample(schema));
  const complete = (responseFormat, correction = '') => {
    let input = content;
    if (correction || responseFormat?.type !== 'json_schema') {
      const feedback = correction ? `上次输出未通过校验（${correction}）。请重新分析同一份输入。\n` : '';
      const hint = feedback + `请只输出一个完整 JSON 对象，按下面的字段和嵌套格式填写内容：\n${example}`;
      input = Array.isArray(content) ? [...content, { type: 'text', text: hint }] : content + '\n\n' + hint;
    }
    return request(config.url, '/chat/completions', {
      ...post({
        model: config.model, response_format: responseFormat,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
      }, signal),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey }, timeout: 3 * 60000,
    });
  };
  const schemaFormat = { type: 'json_schema', json_schema: { name, strict: true, schema } };
  let correction = '';
  for (const format of [schemaFormat, { type: 'json_object' }, undefined]) {
    for (;;) {
      try {
        return validate(await readAnalysisResponse(await complete(format, correction)));
      } catch (error) {
        const unsupported = format && [400, 422, 501].includes(error.status) &&
          /json_schema|json_object|response_format|structured outputs?/i.test(error.message);
        if (unsupported) break;
        if (!(error instanceof AnalysisOutputError)) throw error;
        // Keep one corrective retry across all formats. An accepted format
        // can still return incomplete JSON, so continue with the next format.
        const retried = Boolean(correction);
        correction = error.message;
        if (!retried) continue;
        if (!format) throw error;
        break;
      }
    }
  }
}

async function readAnalysisResponse(response) {
  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('AI 输出达到模型的长度上限，请提高服务端输出上限、换用其他模型或缩减分析素材后重试');
  }
  if (choice?.message?.refusal) throw new Error('AI 服务拒绝分析该素材');
  const contentText = choice?.message?.content;
  const fenced = typeof contentText === 'string' && /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(contentText);
  try { return JSON.parse(fenced ? fenced[1] : contentText || ''); }
  catch { throw new AnalysisOutputError('AI 未返回有效 JSON，请检查模型是否支持结构化输出'); }
}

async function suggestShots(config, template, analysis, inputs, signal) {
  const appearance = template.id === 'fashion' && analysis.productAppearance
    ? '保留用户确认的 productAppearance，颜色、款式和纹理应体现在相关镜头的画面提示词中。'
    : '';
  const transcript = typeof analysis.referenceTranscript === 'string' ? analysis.referenceTranscript.trim() : '';
  const referenceSources = analysis.referenceSources && {
    ...analysis.referenceSources, script: Boolean(inputs.script?.trim()),
    transcription: transcript ? (analysis.referenceSources.transcription === 'partial' ? 'partial' : 'used')
      : ['used', 'partial'].includes(analysis.referenceSources.transcription) ? 'unavailable' : analysis.referenceSources.transcription,
  };
  const reference = referenceSources
    ? '参考 sceneCuts 中的原视频镜头时间。对白以当前文字剧本为准，只有视频转写时从 referenceTranscript 保留相关原话。两项都缺少时让对白留空。'
    : '';
  const prompt = `为「${template.name}」生成分镜建议。优先遵循用户已修订的摘要、角色和场次，按场次顺序排列镜头。${appearance}${reference}${partialTranscriptInstruction(referenceSources)}返回 JSON 对象 {shots:[]}。${shotSchema}`;
  const context = { ...analysis, referenceSources, referenceTranscript: transcript || undefined };
  const shots = await requestAnalysis(config, prompt, JSON.stringify({ analysis: context, inputs }), 'shot_revision', revisionSchema, signal,
    result => cleanShots(result?.shots));
  return applyDialogueEvidence(shots, referenceSources, transcript);
}

function isUnsupportedTranscription(error) {
  return [404, 405, 501].includes(error.status) || error.status === 400 &&
    ['model_not_found', 'unsupported_model'].includes(error.apiCode);
}

function summarizeTranscription(segments) {
  const text = segments.filter(Boolean).join('\n');
  const missing = segments.flatMap((part, index) => part === null ? [index + 1] : []);
  if (!missing.length) return { status: text ? 'used' : 'empty', text };
  const progress = missing.length < segments.length ? { total: segments.length, missing } : undefined;
  return { status: text ? 'partial' : 'unavailable', text, progress };
}

async function transcribeReference(config, file, { signal, hasAlternative, savedSegments, saveSegments } = {}) {
  signal?.throwIfAborted();
  const saved = Array.isArray(savedSegments) && savedSegments.length &&
    savedSegments.every(part => part === null || typeof part === 'string') ? savedSegments : [];
  if (saved.length && !saved.includes(null)) return summarizeTranscription(saved);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-transcription-'));
  try {
    await media.extractAudio(file, path.join(directory, 'audio-%03d.mp3'), signal);
    const names = (await fs.promises.readdir(directory)).filter(item => /^audio-\d+\.mp3$/.test(item))
      .sort((left, right) => Number.parseInt(left.slice(6), 10) - Number.parseInt(right.slice(6), 10));
    const segments = saved.length === names.length ? saved.slice() : names.map(() => null);
    let failure;
    for (const [index, name] of names.entries()) {
      signal?.throwIfAborted();
      if (segments[index] !== null) continue;
      const form = new FormData();
      form.append('model', config.transcriptionModel || 'whisper-1');
      form.append('file', await fs.openAsBlob(path.join(directory, name), { type: 'audio/mpeg' }), name);
      let result;
      try {
        const response = await request(config.url, '/audio/transcriptions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey }, body: form, signal, timeout: 5 * 60000,
        });
        result = await response.json();
      } catch (error) {
        signal?.throwIfAborted();
        if (isUnsupportedTranscription(error)) break;
        if (error instanceof SyntaxError) continue;
        if (isTemporaryConnectionFailure(error) || error.name === 'TypeError' && error.message === 'terminated') {
          failure ??= error;
          if (error.status === 429) break;
          continue;
        }
        // An endpoint-wide error after some speech was captured leaves a usable partial result.
        if (error.status && segments.some(Boolean)) break;
        throw error;
      }
      signal?.throwIfAborted();
      if (typeof result?.text !== 'string') continue;
      segments[index] = result.text.trim();
      await saveSegments?.(segments.slice());
    }
    signal?.throwIfAborted();
    const result = summarizeTranscription(segments);
    if (!result.text && failure && !hasAlternative) throw failure;
    return result;
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  importMedia, relinkMedia,
  DEFAULT_COMFY, baseUrl, workflowVariables, assetVariables, checkComfy, hasMpsVideoNodes, validateWorkflow, buildPrompt,
  preflight, uploadAsset, submit, submitPrepared, observeComfyProgress, findPrompt, waitPrompt, cancelPrompt, collect, analyze, suggestShots,
  transcribeReference, transcriptionSources,
  outputRecords, downloadOutput, isTemporaryConnectionFailure, normalizeProductAppearance, probe: media.probe,
  exportVideo, createMediaProxy: media.createProxy,
};
