const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { HeifDecoder } = require('libheif-js/wasm-bundle');
const { PNG } = require('pngjs');

async function convert({ source, output }) {
  if (fs.statSync(source).size > 128 * 1024 ** 2) throw new Error('HEIC/HEIF 文件超过 128 MiB，请先缩小原图');
  const images = new HeifDecoder().decode(fs.readFileSync(source));
  const image = images.find(frame => frame.is_primary()) ?? images[0];
  if (!image) throw new Error('无法解码 HEIC/HEIF 主图');
  const width = image.get_width(), height = image.get_height();
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 64_000_000) {
    throw new Error('HEIC/HEIF 主图尺寸无效或超过 6400 万像素');
  }
  const decoded = await new Promise((resolve, reject) => {
    image.display({ width, height, data: new Uint8ClampedArray(pixels * 4) }, result => {
      if (result) resolve(result);
      else reject(new Error('无法解码 HEIC/HEIF 主图'));
    });
  });
  const data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  fs.writeFileSync(output, PNG.sync.write({ width, height, data }), { flag: 'wx' });
}

void convert(workerData).catch(error => {
  parentPort.postMessage({ code: error.code, message: error.message });
  process.exitCode = 1;
});
