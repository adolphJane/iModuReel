const fs = require('node:fs/promises');
const path = require('node:path');
const { command } = require('./install-command.cjs');

const markerName = '.imodureel-revision';
const required = ['main.py', 'requirements.txt'];
const projectData = new Set(['models', 'input', 'output', 'temp', 'user', 'custom_nodes']);

async function fileType(file) {
  return fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function inspectSource(directory) {
  const folder = await fileType(directory);
  if (!folder?.isDirectory()) return { exists: Boolean(folder), conflict: Boolean(folder), revision: null, complete: false };
  const marker = path.join(directory, markerName);
  const info = await fileType(marker);
  if (info && !info.isFile()) return { exists: true, conflict: true, revision: null, complete: false };
  const revision = info ? (await fs.readFile(marker, 'utf8')).trim() : null;
  const entries = await Promise.all(required.map(name => fileType(path.join(directory, name))));
  return { exists: true, conflict: false, revision, complete: entries.every(entry => entry?.isFile() && entry.size > 0) };
}

async function restoreStockFiles(staged, installed, signal, topLevel = true) {
  for (const entry of await fs.readdir(staged, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (topLevel && projectData.has(entry.name)) continue;
    const from = path.join(staged, entry.name);
    const to = path.join(installed, entry.name);
    const current = await fileType(to);
    const isDirectory = entry.isDirectory();
    if ((!isDirectory && !entry.isFile()) ||
        (current && (isDirectory ? !current.isDirectory() : !current.isFile()))) {
      throw new Error(`受管程序文件路径已被替换，修复前请核对：${to}`);
    }
    if (isDirectory) {
      await fs.mkdir(to, { recursive: true });
      await restoreStockFiles(from, to, signal, false);
    } else await fs.rename(from, to);
  }
}

async function ensureComfySource(directory, { revision, repair, canRepair, getArchive, signal, emit }) {
  const source = await inspectSource(directory);
  if (source.conflict || source.revision !== null && source.revision !== revision) {
    throw new Error('受管引擎版本不匹配或目录已被替换，请核对现有安装目录');
  }
  if (source.exists && source.revision === null && !canRepair) {
    throw new Error('该目录中已有未验证的 ComfyUI。可连接它，或选择新目录安装受管引擎');
  }
  if (source.revision === revision && source.complete && !repair) return;

  const root = path.dirname(directory);
  const archive = await getArchive();
  const temporary = await fs.mkdtemp(path.join(root, '.extract-'));
  try {
    await command('tar', ['-xf', archive, '--strip-components', '1', '-C', temporary], root, { signal, emit });
    if (!(await inspectSource(temporary)).complete) throw new Error('下载的 ComfyUI 程序文件不完整');
    await fs.writeFile(path.join(temporary, markerName), revision);
    signal.throwIfAborted();
    if (source.exists) await restoreStockFiles(temporary, directory, signal);
    else await fs.rename(temporary, directory);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { inspectSource, ensureComfySource };
