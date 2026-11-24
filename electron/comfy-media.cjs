const fs = require('node:fs/promises');
const path = require('node:path');

const uuidPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const uuid = new RegExp('^' + uuidPattern + '$');
const uploadPattern = new RegExp('^imodureel-job-(' + uuidPattern + ')-(' + uuidPattern + ')-');
const outputFolder = '.imodureel-jobs';

function uploadTag(owner, attempt) {
  return 'imodureel-job-' + owner + '-' + attempt;
}

function scopeOutputs(prompt, jobId, promptId) {
  const directory = [outputFolder, jobId, promptId].join('/');
  return Object.fromEntries(Object.entries(prompt).map(([id, node]) => {
    const prefix = node.inputs.filename_prefix;
    if (typeof prefix !== 'string') return [id, node];
    const relative = prefix.replaceAll('\\', '/');
    if (relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').includes('..')) return [id, node];
    const scoped = path.posix.join(directory, relative || 'output');
    return [id, { ...node, inputs: { ...node.inputs, filename_prefix: scoped === directory ? directory + '/output' : scoped } }];
  }));
}

async function localFolder(root, ...components) {
  if (!root || !path.isAbsolute(root)) return null;
  let directory = root;
  for (const component of ['ComfyUI', ...components]) {
    directory = path.join(directory, component);
    const info = await fs.lstat(directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isDirectory()) return null;
  }
  return directory;
}

async function removeUploads(root, owners, attempt) {
  if (!owners.size) return;
  const input = await localFolder(root, 'input');
  if (!input) return;
  for (const entry of await fs.readdir(input, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = uploadPattern.exec(entry.name);
    if (match && owners.has(match[1]) && (!attempt || attempt === match[2])) {
      await fs.rm(path.join(input, entry.name), { force: true });
    }
  }
}

async function removeOutputs(root, jobs, attempt) {
  if (!jobs.size) return;
  const output = await localFolder(root, 'output', outputFolder);
  if (!output) return;
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuid.test(entry.name) || !jobs.has(entry.name)) continue;
    const directory = path.join(output, entry.name);
    if (attempt && uuid.test(attempt)) {
      await fs.rm(path.join(directory, attempt), { recursive: true, force: true });
      await fs.rmdir(directory).catch(error => {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
      });
    } else if (!attempt) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { uploadTag, scopeOutputs, removeUploads, removeOutputs };
