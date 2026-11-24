const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const storageFullMessage = '磁盘空间不足。请释放应用数据、项目或系统临时目录所在磁盘的空间后重试。';
const isStorageFull = error => ['ENOSPC', 'EDQUOT'].includes(error?.code);
const hasStorageFullMessage = message => /no space left on device|disk quota exceeded|not enough space on (?:the )?disk/i.test(message);

async function copyAssetFile(source, destination, signal) {
  const digest = createHash('sha256');
  const fingerprint = new Transform({
    transform(chunk, encoding, done) {
      digest.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(source), fingerprint, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
  return digest.digest('hex');
}

async function assetFingerprint(file, signal) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) digest.update(chunk);
  return digest.digest('hex');
}

const verified = new Map();

async function fileStamp(file) {
  const stat = await fs.promises.stat(file, { bigint: true }).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
  return stat?.isFile() && stat.size > 0n
    ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : null;
}

async function assetFileState(asset, signal) {
  signal?.throwIfAborted();
  if (!asset?.path) return 'missing';
  const stamp = await fileStamp(asset.path);
  signal?.throwIfAborted();
  if (!stamp) return 'missing';
  if (!asset.sha256) return 'ready';
  const cached = verified.get(asset.path);
  if (cached?.stamp === stamp) return cached.sha256 === asset.sha256 ? 'ready' : 'changed';
  const sha256 = await assetFingerprint(asset.path, signal).catch(error => {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  });
  if (!sha256) return 'missing';
  const finalStamp = await fileStamp(asset.path);
  signal?.throwIfAborted();
  if (!finalStamp) return 'missing';
  if (finalStamp !== stamp) return 'changed';
  verified.delete(asset.path);
  if (verified.size >= 128) verified.delete(verified.keys().next().value);
  verified.set(asset.path, { stamp, sha256 });
  return sha256 === asset.sha256 ? 'ready' : 'changed';
}

async function requireAssetFile(asset, signal) {
  const state = await assetFileState(asset, signal);
  if (state === 'ready') return;
  const name = asset?.name || (asset?.path && path.basename(asset.path)) || '时间线素材';
  if (state === 'changed') {
    throw new Error(`素材内容已变更，请到「项目素材」重新定位或替换后再试：${name}`);
  }
  throw new Error(`素材丢失，请到「项目素材」重新定位后再试：${name}`);
}

module.exports = {
  copyAssetFile, assetFingerprint, assetFileState, requireAssetFile, isStorageFull, hasStorageFullMessage, storageFullMessage,
};
