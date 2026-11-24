const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const bundled = require('ffmpeg-static');
const { assetFingerprint, requireAssetFile, hasStorageFullMessage } = require('./asset-file.cjs');
const { version } = require('../package.json');

function resolveFFmpeg() {
  const unpacked = bundled?.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return [unpacked, bundled].find(candidate => candidate && fs.existsSync(candidate)) || 'ffmpeg';
}

function hasRenderFile(file) {
  if (typeof file !== 'string' || !file) return false;
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return Boolean(stat?.isFile() && stat.size > 0);
  } catch {
    return false;
  }
}

const hdrTransfers = new Set(['smpte2084', 'arib-std-b67']);
const bt709Tags = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const bt709Color = 'primaries=bt709:transfer=bt709:matrix=bt709:range=limited';
const srgbColor = 'primaries=bt709:transfer=iec61966-2-1:matrix=gbr:range=full';

function readColor(stream) {
  const [, format = '', labels = ''] = stream?.match(/,\s+([a-z]\w*)(?:\(([^)]*)\))?,\s+\d+x\d+/) ?? [];
  const tags = labels.split(',').map(label => label.trim());
  // FFmpeg prints a single label when all three color properties have the same name.
  const tuple = tags.find(label => label.includes('/'));
  const single = tags.find(label => ['bt709', 'smpte170m', 'smpte240m'].includes(label));
  const [matrix, primaries, transfer] = tuple ? tuple.split('/') : [single, single, single];
  const known = value => Boolean(value && !['unknown', 'unspecified', 'reserved'].includes(value));
  const rgb = /^(?:rgb|bgr|gbr|argb|abgr|pal8)/.test(format);
  return {
    hdr: hdrTransfers.has(transfer), matrix: known(matrix), primaries: known(primaries), transfer: known(transfer),
    range: tags.includes('tv') || tags.includes('pc'), rgb,
    alpha: /^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya)/.test(format),
  };
}

function normalizeColor(color, { pixelFormat = 'yuv420p', rgbOutput = false } = {}) {
  const target = rgbOutput ? srgbColor : bt709Color;
  const output = `format=${pixelFormat}`;
  const matrix = color.rgb ? 'gbr' : color.hdr ? 'bt2020nc' : 'smpte170m';
  const primaries = color.hdr ? 'bt2020' : 'bt709';
  const range = color.rgb ? 'full' : 'limited';
  if (!color.hdr) {
    const input = [
      !color.matrix && `matrixin=${matrix}`, !color.primaries && `primariesin=${primaries}`,
      !color.transfer && `transferin=${color.rgb ? 'iec61966-2-1' : 'bt709'}`, !color.range && `rangein=${range}`,
    ].filter(Boolean);
    return `zscale=${[...input, target].join(':')},${output}`;
  }
  const defaults = [
    !color.matrix && `colorspace=${matrix}`, !color.primaries && `color_primaries=${primaries}`, !color.range && `range=${range}`,
  ].filter(Boolean);
  const tagged = defaults.length ? `setparams=${defaults.join(':')},` : '';
  // Use the same 1,000-nit reference for PQ and HLG across preview and export.
  return `${tagged}zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=hable:peak=10,zscale=${target},${output}`;
}

const prematureMediaEnd = /^\[(?:matroska,webm|mov,mp4,m4a,3gp,3g2,mj2) @ [^\]\r\n]+\] [^\r\n]*(?:File ended prematurely|partial file)\s*$/im;

function execute(args, { signal, cwd, onProgress, onStderr, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const options = { signal, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = childProcess.spawn(resolveFFmpeg(), allowFailure ? args : ['-xerror', ...args], options);
    let progress = '';
    let spawnError;
    child.stdout.on('data', data => {
      progress += data;
      const lines = progress.split('\n');
      progress = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) onProgress?.(Number(line.slice(12)) / 1e6);
      }
    });
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-100_000);
      onStderr?.(String(data));
    });
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      if (signal?.aborted) return reject(signal.reason);
      if (spawnError) return reject(spawnError.code === 'ENOENT' ? new Error('未找到 FFmpeg，请检查应用安装') : spawnError);
      if (allowFailure) return resolve(stderr);
      // Some demuxers report a truncated stream but still exit successfully.
      const truncated = stderr.match(prematureMediaEnd);
      if (truncated) return reject(new Error('媒体文件未完整读取，请重新获取原文件或重新定位素材。', { cause: truncated[0].trim() }));
      if (code === 0) return resolve(stderr);
      const error = new Error(stderr.trim().split('\n').slice(-10).join('\n') || `FFmpeg 退出码 ${code}`);
      if (hasStorageFullMessage(stderr)) error.code = 'ENOSPC';
      reject(error);
    });
  });
}

const stillExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic']);

async function verifyMovieBoxes(file, signal) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    // Fast-start MP4/MOV can advertise the original duration after losing
    // media data. FFmpeg may treat a cut exactly between packets as clean EOF.
    for (let offset = 0; offset + 8 <= size;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(header, 0, header.length, offset);
      if (bytesRead < 8) throw incompleteMedia();
      const shortSize = header.readUInt32BE(0);
      const extended = shortSize === 1;
      const baseHeaderSize = extended ? 16 : 8;
      const headerSize = baseHeaderSize + (header.toString('ascii', 4, 8) === 'uuid' ? 16 : 0);
      if (bytesRead < baseHeaderSize) throw incompleteMedia();
      const length = extended ? header.readBigUInt64BE(8) : BigInt(shortSize || size - offset);
      if (length < BigInt(headerSize) || length > BigInt(size - offset)) throw incompleteMedia();
      offset += Number(length);
    }
  } finally {
    await handle.close();
  }

  function incompleteMedia() {
    return Object.assign(new Error(`媒体文件不完整，请重新获取原文件或重新定位素材：${path.basename(file)}`), {
      code: 'INCOMPLETE_MEDIA',
    });
  }
}

async function probe(file, signal) {
  const report = await execute(['-hide_banner', '-i', file], { allowFailure: true, signal });
  const videoStreams = report.split('\n').filter(line => /Stream #.*Video:/.test(line) && !line.includes('(attached pic)'));
  const videoStream = videoStreams[0];
  const video = Boolean(videoStream);
  const audio = /Stream #.*Audio:/.test(report);
  const time = report.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const kind = video ? (stillExtensions.has(path.extname(file).toLowerCase()) ? 'image' : 'video') : 'audio';
  if (!video && !audio) {
    const error = new Error(`无法读取媒体：${path.basename(file)}`);
    error.code = 'UNREADABLE_MEDIA';
    throw error;
  }
  const isoMedia = /^Input #0, mov,mp4,m4a,3gp,3g2,mj2, from /m.test(report);
  if (isoMedia) await verifyMovieBoxes(file, signal);
  // Matroska and WebM audio use container timestamps coarser than the
  // sample clock. Seeking can change FFmpeg's carried rounding phase.
  const indexedMedia = isoMedia || !audio && /^Input #0, matroska,webm, from /m.test(report);
  const duration = kind !== 'image' && time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : null;
  const dimensions = videoStream?.match(/\b([1-9]\d*)x([1-9]\d*)\b/);
  const sampleRatio = videoStream?.match(/\bSAR ([1-9]\d*):([1-9]\d*)\b/);
  const rotation = Number(report.match(/displaymatrix: rotation of (-?[\d.]+) degrees/)?.[1] ?? 0);
  const fps = Number(videoStream?.match(/\b([\d.]+) fps\b/)?.[1]) || null;
  const nominalFps = Number(videoStream?.match(/\b([\d.]+) tbr\b/)?.[1]) || null;
  return {
    video, audio, kind, duration, rotation, fps, nominalFps, color: readColor(videoStream),
    videoCodec: videoStream?.match(/\bVideo: ([\w-]+)/)?.[1],
    sampleAspectRatio: sampleRatio ? [Number(sampleRatio[1]), Number(sampleRatio[2])] : [1, 1],
    canSeekForRender: indexedMedia && videoStreams.length <= 1,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
  };
}

function enhancementBatchSize({ width, height, fps }) {
  if (!width || !height || !fps) {
    throw new Error('无法读取增强素材的分辨率或帧率，请先将视频转为 MP4');
  }
  // Real-ESRGAN produces a batch of float RGB frames at 4× the input dimensions.
  const frameBytes = width * height * 16 * 3 * 4;
  return Math.max(1, Math.floor(768 * 1024 ** 2 / frameBytes));
}

async function enhancementVideoStart(input, signal) {
  const report = await execute(['-hide_banner', '-copyts', '-start_at_zero', '-i', input, '-map', '0:V:0', '-an',
    '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-'], { signal });
  const time = Number(report.match(/\bpts_time:([-+\deE.]+)/)?.[1]);
  if (!Number.isFinite(time)) throw new Error('无法读取增强素材的画面起点');
  return Math.max(0, time);
}

function enhancementEncodeArgs(input, { fps, width, height, color, firstFrame, frames }) {
  const [numerator, denominator] = enhancementRate(fps);
  const pixelFormat = width % 2 || height % 2 ? 'yuv444p' : 'yuv420p';
  // Conform the original frame grid before trimming, including variable-rate footage.
  const filters = ['setpts=PTS-STARTPTS', `fps=${numerator}/${denominator}:start_time=0`];
  if (frames !== undefined) filters.push(`trim=start_frame=${firstFrame}:end_frame=${firstFrame + frames}`, 'setpts=PTS-STARTPTS');
  if (color?.hdr) filters.push(normalizeColor(color, { pixelFormat }));
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:V:0', '-an', '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', pixelFormat, '-bf', '0',
    ...(color?.hdr ? bt709Tags : [])];
}

async function splitEnhancement(input, directory, { batchSize, ...details }, signal) {
  const [numerator, denominator] = enhancementRate(details.fps);
  const rate = numerator / denominator;
  await fs.promises.mkdir(directory, { recursive: true });
  await execute([...enhancementEncodeArgs(input, details),
    '-force_key_frames', `expr:gte(n,n_forced*${batchSize})`, '-sc_threshold', '0',
    '-f', 'segment', '-segment_time', String(batchSize / rate), '-segment_time_delta', String(0.5 / rate),
    '-segment_list', 'source.csv', '-segment_list_type', 'csv',
    '-reset_timestamps', '1', 'source-%06d.mp4'], { cwd: directory, signal });
  const csv = await fs.promises.readFile(path.join(directory, 'source.csv'), 'utf8');
  const segments = csv.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [file, start, end] = line.split(',');
    const frames = Math.round((Number(end) - Number(start)) * rate);
    if (!/^source-\d+\.mp4$/.test(file) || !(frames > 0 && frames <= batchSize)) {
      throw new Error('增强切分结果异常，请检查源视频的时间戳');
    }
    return { file, frames };
  });
  if (!segments.length) throw new Error('未能切分增强素材，请检查源视频');
  return segments;
}

async function rebuildEnhancementSegment(input, output, details, signal) {
  await execute([...enhancementEncodeArgs(input, details), '-frames:v', String(details.frames), output], { signal });
}

function enhancementRate(fps) {
  return { 23.98: [24000, 1001], 29.97: [30000, 1001], 59.94: [60000, 1001], 119.88: [120000, 1001] }[fps] || [fps, 1];
}

async function countVideoFrames(input, signal, { decode = false } = {}) {
  const report = await execute(['-hide_banner', '-i', input, '-an', '-map', '0:V:0',
    ...(decode ? ['-fps_mode', 'passthrough'] : ['-c:v', 'copy']),
    '-f', 'null', '-'], { signal });
  return Number(Array.from(report.matchAll(/frame=\s*(\d+)/g)).at(-1)?.[1] ?? 0);
}

async function isBlackVideo(input, signal) {
  const report = await execute(['-hide_banner', '-nostats', '-i', input, '-map', '0:V:0',
    '-vf', 'blackframe=amount=100:threshold=17', '-fps_mode', 'passthrough', '-an', '-f', 'null', '-'], { signal });
  const frames = Number(report.match(/\bframe=\s*(\d+)/)?.[1] ?? 0);
  const black = report.match(/Parsed_blackframe_\d+[^\n]*\bframe:\d+\s+pblack:100\b/g)?.length ?? 0;
  return frames > 0 && frames === black;
}

async function joinEnhancement(input, directory, segments, { fps, videoStart = 0, sourceDuration }, output, signal) {
  const list = path.join(directory, 'enhanced.ffconcat');
  const [numerator, denominator] = enhancementRate(fps);
  const rate = numerator / denominator;
  // Supply exact segment lengths to prevent container-level millisecond rounding accumulating across cuts.
  const entries = segments.flatMap(({ file, frames }) => [`file '${file}'`, `duration ${(frames / rate).toFixed(9)}`]);
  await fs.promises.writeFile(list, ['ffconcat version 1.0', ...entries, ''].join('\n'));
  const source = await probe(input, signal);
  const audioEnd = sourceDuration ?? source.duration;
  // AAC decoding can expose padding after the source ends. Keep deliberate
  // audio tails after the picture, and drop only samples past the source end.
  const audioTrim = audioEnd ? ['-af', `atrim=end=${audioEnd}`] : [];
  // ComfyUI passes pixels through image tensors, which do not carry pixel aspect ratio.
  // FFmpeg baked quarter-turn rotation into the pixels before sending the segments.
  const [sarWidth, sarHeight] = Math.abs(source.rotation % 180) === 90
    ? source.sampleAspectRatio.toReversed() : source.sampleAspectRatio;
  const aspect = [];
  if (sarWidth !== sarHeight) {
    const enhanced = await probe(path.join(directory, segments[0].file), signal);
    aspect.push('-aspect:v', `${enhanced.width * sarWidth}:${enhanced.height * sarHeight}`);
    if (enhanced.videoCodec === 'h264') {
      aspect.push('-bsf:v', `h264_metadata=sample_aspect_ratio=${sarWidth}/${sarHeight}`);
    }
  }
  await execute(['-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-start_at_zero',
    '-itsoffset', String(videoStart), '-f', 'concat', '-safe', '1', '-i', list, '-i', input,
    '-map', '0:v:0', '-map', '1:a:0?', '-avoid_negative_ts', 'disabled', '-c:v', 'copy',
    ...aspect, ...audioTrim, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], { signal });
}

function normalizeVideoRotation(input, output, signal) {
  // ComfyUI decodes the pixels directly. FFmpeg applies the display matrix before encoding.
  return execute(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:V:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-c:a', 'aac', '-b:a', '192k',
    '-fps_mode', 'passthrough', '-movflags', '+faststart', output], { signal });
}

async function createProxy(asset, destination, signal, info) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', asset.path];
  const partial = path.join(path.dirname(destination), randomUUID() + path.extname(destination));
  const color = asset.kind === 'audio' ? null : (info ?? await probe(asset.path, signal)).color;
  if (asset.kind === 'video') {
    const fit = "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30";
    args.push('-map', '0:V:0', '-map', '0:a:0?',
      '-vf', color.hdr ? `${fit},${normalizeColor(color)}` : fit,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-pix_fmt', 'yuv420p',
      ...(color.hdr ? bt709Tags : []), '-c:a', 'aac', '-movflags', '+faststart');
  } else if (asset.kind === 'audio') {
    args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-movflags', '+faststart');
  } else {
    args.push('-map', '0:V:0', '-frames:v', '1', '-c:v', 'png');
    if (color.hdr) args.push('-vf', normalizeColor(color, { pixelFormat: 'gbrp', rgbOutput: true }));
  }
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await execute([...args, partial], { signal });
    signal?.throwIfAborted();
    await fs.promises.rename(partial, destination);
  } finally {
    await fs.promises.rm(partial, { force: true }).catch(() => {});
  }
}

const showFrame = 'showinfo=checksum=0';
const frameTimestamps = ['-copyts', '-start_at_zero'];

function readPictureTimestamp(line) {
  const match = /\[Parsed_showinfo_\d+ [^\]]+\]\s+n:\s*\d+\s+pts:\s*(-?\d+)\b/.exec(line);
  if (!match) return null;
  return {
    time: Number(match[1]) / 1e6,
    duration: (Number(/\bduration:\s*(\d+)\b/.exec(line)?.[1]) || 0) / 1e6,
  };
}

async function detectScenes(file, { duration, fps }, signal) {
  const boundaries = [];
  let partial = '';
  let cut = false;
  let last = null;
  let previous = null;
  const onStderr = chunk => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (line.includes('lavfi.scd.time:')) cut = true;
      const picture = readPictureTimestamp(line);
      if (!picture) continue;
      if (picture.time >= 0) {
        if (!boundaries.length || cut && picture.time > boundaries.at(-1) + 0.2) boundaries.push(picture.time);
        if (!last || picture.time > last.time) {
          previous = last;
          last = picture;
        }
      }
      cut = false;
    }
  };
  await execute(['-hide_banner', '-nostats', ...frameTimestamps, '-i', file, '-map', '0:V:0', '-an',
    '-vf', `settb=AVTB,scale=320:-2,scdet=threshold=12,${showFrame}`, '-fps_mode', 'passthrough', '-f', 'null', '-'],
  { signal, onStderr });
  if (!last) return { cuts: [], end: null, lastFrame: null };
  const frameDuration = last.duration || (previous && last.time - previous.time) || (fps ? 1 / fps : 0);
  const end = Math.max(last.time, Math.min(last.time + frameDuration, duration ?? Infinity));
  const starts = boundaries.filter((time, index) => index === 0 || time < end - 0.2);
  return { cuts: starts.map((start, index) => ({ start, end: starts[index + 1] ?? end })), end, lastFrame: last.time };
}

function extractAudio(input, outputPattern, signal) {
  return execute(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', '540', outputPattern], { signal });
}

async function extractFrame(input, time, output, signal, info) {
  const target = Math.round(time * 1e6);
  const color = (info ?? await probe(input, signal)).color;
  const colorFilter = color.hdr ? ',' + normalizeColor(color, { pixelFormat: 'gbrp', rgbOutput: true }) : '';
  const filters = `settb=AVTB,trim=start_pts=${target},scale=512:512:force_original_aspect_ratio=decrease:force_divisible_by=2${colorFilter},${showFrame}`;
  const extract = async seek => {
    const report = await execute(['-hide_banner', '-nostats', '-y', ...frameTimestamps,
      ...(seek > 0 ? ['-ss', String(seek)] : []), '-i', input, '-map', '0:V:0', '-an',
      '-vf', filters, '-fps_mode', 'passthrough', '-frames:v', '1', output], { signal });
    if (!hasRenderFile(output)) return null;
    return report.split('\n').map(readPictureTimestamp).find(Boolean)?.time ?? null;
  };
  // Seek ahead for speed, then select against the original clock in the filter.
  const seek = Math.max(0, time - 0.25);
  const stamped = await extract(seek);
  return stamped === null && seek > 0 ? extract(0) : stamped;
}

const profiles = {
  landscape: [1280, 720],
  portrait: [720, 1280],
  square: [720, 720],
};

function timeNumber(input, min, max, label) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) {
    throw new Error(`${label}超出有效范围`);
  }
  return input;
}

function frameAtOrAfter(time, fps) {
  // Exact frame boundaries can pick up tiny rounding errors during timeline edits.
  return Math.ceil(time * fps - 0.000001);
}

function pictureRange(start, duration, fps) {
  const pictureStart = frameAtOrAfter(start, fps);
  return { pictureStart, pictureEnd: Math.max(pictureStart + 1, frameAtOrAfter(start + duration, fps)) };
}

function pictureIsActive({ pictureStart, pictureEnd }, fps) {
  return `gte(t*${fps}+0.000001,${pictureStart})*lt(t*${fps}+0.000001,${pictureEnd})`;
}

function xml(text) {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function captionLines(text, width, size) {
  const lineLength = Math.floor(width / size) - 3;
  return text.trim().split(/\r?\n/).flatMap(line => {
    const chars = Array.from(line);
    return Array.from({ length: Math.max(1, Math.ceil(chars.length / lineLength)) },
      (_, index) => chars.slice(index * lineLength, (index + 1) * lineLength).join(''));
  });
}

function captionPng(lines, width, height, size) {
  const { Resvg } = require('@resvg/resvg-js');
  const first = height - size * (2 + (lines.length - 1) * 1.25);
  const font = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif';
  const elements = lines.map((line, i) => `<text x="${width / 2}" y="${first + size * i * 1.25}">${xml(line)}</text>`).join('');
  const layer = `font-family="${font}" font-size="${size}" text-anchor="middle"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g ${layer} fill="black" stroke="black" stroke-width="${Math.max(2, size / 9)}" stroke-linejoin="round">${elements}</g><g ${layer} fill="white">${elements}</g></svg>`;
  return new Resvg(svg).render().asPng();
}

function composeCaptionLayers(pages, { height, fontSize, fps }) {
  const boundaries = new Map();
  const changesAt = time => {
    if (!boundaries.has(time)) boundaries.set(time, { starts: [], ends: [] });
    return boundaries.get(time);
  };
  pages.forEach(({ start, end }, index) => {
    changesAt(start).starts.push(index);
    changesAt(end).ends.push(index);
  });
  const times = [...boundaries.keys()].sort((a, b) => a - b);
  const active = new Set();
  const layers = [];
  for (const [index, start] of times.entries()) {
    const { starts, ends } = boundaries.get(start);
    for (const page of ends) active.delete(page);
    for (const page of starts) active.add(page);
    if (!active.size) continue;
    const lines = [...active].sort((a, b) => a - b).flatMap((page, position) =>
      position ? ['', ...pages[page].lines] : pages[page].lines);
    const size = Math.min(fontSize, Math.floor(height / (4 + (lines.length - 1) * 1.25)));
    if (size < fontSize * 0.6) throw new Error('同时显示的字幕过多，请错开或拆分字幕后重试');
    const end = times[index + 1];
    layers.push({ start: start / fps, duration: (end - start) / fps,
      pictureStart: start, pictureEnd: end, lines, fontSize: size });
  }
  return layers;
}

const sampleRate = 48000;

function validateExportFrameRate(fps) {
  if (![24, 25, 30, 50, 60].includes(fps)) throw new Error('请选择有效的导出帧率');
}

async function prepareLayers(clips, assets, signal, style) {
  const sources = new Map();
  const layers = [];
  for (const clip of clips.filter(item => item.kind !== 'subtitle')) {
    signal?.throwIfAborted();
    const asset = assets.get(clip.asset_id);
    if (!sources.has(asset.path)) sources.set(asset.path, { asset, info: await probe(asset.path, signal) });
    const source = sources.get(asset.path);
    if (source.info.duration && clip.in_point + clip.duration > source.info.duration + 0.1) {
      throw new Error(`片段超出素材时长：${asset.name || path.basename(asset.path)}`);
    }
    const picture = clip.kind === 'video' ? pictureRange(clip.start, clip.duration, style.fps) : {};
    layers.push({ ...clip, ...picture, source });
  }
  const linesPerPage = 8;
  const captionPages = [];
  for (const clip of clips.filter(item => item.kind === 'subtitle' && item.text?.trim())) {
    const lines = captionLines(clip.text, style.captions.width, style.captions.fontSize);
    const pages = Math.ceil(lines.length / linesPerPage);
    const { pictureStart, pictureEnd } = pictureRange(clip.start, clip.duration, style.fps);
    const frames = pictureEnd - pictureStart;
    if (pages > frames) throw new Error('字幕内容超出片段时长，请延长片段或拆分字幕');
    for (let page = 0; page < pages; page++) {
      const first = page * linesPerPage;
      captionPages.push({ start: pictureStart + Math.floor(page * frames / pages),
        end: pictureStart + Math.floor((page + 1) * frames / pages),
        lines: lines.slice(first, first + linesPerPage) });
    }
  }
  layers.push(...composeCaptionLayers(captionPages, { ...style.captions, fps: style.fps }));
  return layers.map((layer, order) => ({
    ...layer, order,
    // Include the nearest audio sample. A window can cut inside either stream.
    firstFrame: Math.floor(Math.min(layer.start, Math.round(layer.start * sampleRate) / sampleRate) * style.fps),
    end: Math.max((layer.pictureEnd ?? 0) / style.fps,
      Math.max(layer.start, Math.round(layer.start * sampleRate) / sampleRate) + layer.duration),
    // Leave room for quoting and the other arguments in a Windows process command line.
    inputCost: 80 + 2 * (layer.source?.asset.path.length ?? 25),
  }));
}

function renderWindows(layers, duration, fps) {
  const maxInputs = 18;
  const maxInputCost = 22000;
  const pending = [...layers].sort((left, right) => left.firstFrame - right.firstFrame);
  const windows = [];
  let selected = [];
  let cost = 0;
  let firstFrame = 0;
  for (let cursor = 0; cursor < pending.length;) {
    const next = pending[cursor].firstFrame;
    const beginning = cursor;
    let addedCost = 0;
    while (pending[cursor]?.firstFrame === next) addedCost += pending[cursor++].inputCost;
    if (next > firstFrame && selected.length &&
        (selected.length + cursor - beginning > maxInputs || cost + addedCost > maxInputCost)) {
      const end = next / fps;
      windows.push({ firstFrame, end, layers: selected });
      selected = selected.filter(previous => previous.end > end);
      cost = selected.reduce((sum, previous) => sum + previous.inputCost, 0);
      firstFrame = next;
    }
    selected.push(...pending.slice(beginning, cursor));
    cost += addedCost;
  }
  windows.push({ firstFrame, end: duration, layers: selected });
  return windows;
}

function renderCommandLength(args) {
  // Count UTF-16 code units, including space for quoting, separators and the terminator.
  return args.reduce((length, arg) => length + arg.length + 3, resolveFFmpeg().length + 4);
}

async function shortenRenderInputs(args, inputIndexes, temp, aliases, signal) {
  const maxLength = 32767;
  if (renderCommandLength(args) <= maxLength) return;
  for (const index of inputIndexes) {
    signal?.throwIfAborted();
    const directory = path.dirname(args[index]);
    if (!aliases.has(directory)) {
      const alias = 'media-' + aliases.size;
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      const created = await fs.promises.symlink(directory, path.join(temp, alias), type).then(() => alias, () => null);
      aliases.set(directory, created);
    }
    const alias = aliases.get(directory);
    if (alias) {
      const shorter = path.join(alias, path.basename(args[index]));
      if (shorter.length < args[index].length) args[index] = shorter;
    }
  }
  if (process.platform === 'win32' && renderCommandLength(args) > maxLength) {
    throw new Error('Windows 导出的命令过长。可缩短项目素材路径，或减少同一时间叠放的片段后重试。');
  }
}

function seekOptions(seconds) {
  // Restore the input's original timestamps for the video and audio filters.
  return ['-ss', String(seconds), '-noaccurate_seek', '-itsoffset', String(seconds)];
}

async function renderSeek(layer, firstPicture, signal) {
  const { source, in_point: audioStart } = layer;
  const { asset, info } = source;
  if (asset.kind === 'image' || !info.canSeekForRender) return [];
  const hasPicture = layer.kind === 'video' && info.video;
  if (!hasPicture && !info.audio) return [];
  const start = hasPicture ? Math.min(audioStart, firstPicture) : audioStart;
  const seek = Math.floor(start) - 2;
  if (seek < 4) return [];

  const cache = source.seekStarts ??= new Map();
  const key = [seek, hasPicture].join(':');
  if (!cache.has(key)) {
    const args = ['-hide_banner', '-nostats', ...seekOptions(seek), '-i', asset.path];
    if (hasPicture) args.push('-map', '0:V:0', '-vf', 'showinfo=checksum=0', '-frames:v', '1', '-an', '-f', 'null', '-');
    if (info.audio) args.push('-map', '0:a:0', '-af', 'ashowinfo', '-frames:a', '1', '-vn', '-f', 'null', '-');
    const report = await execute(args, { signal, allowFailure: true });
    const lines = report.split('\n');
    const timestamp = filter => {
      const first = lines.find(line => line.includes(`[Parsed_${filter}_`) && line.includes('pts_time:'));
      return Number(first?.match(/\bpts_time:([-+\d.eE]+)/)?.[1]);
    };
    cache.set(key, { picture: timestamp('showinfo'), audio: timestamp('ashowinfo') });
  }
  const first = cache.get(key);
  // B-frame reordering can put the seek keyframe's presentation time after
  // the cut on sparse material. Verify the required preroll before using it.
  if (hasPicture && !(first.picture < firstPicture - 0.000001)) return [];
  if (info.audio && !(first.audio <= audioStart - 0.1)) return [];
  return seekOptions(seek);
}

async function renderCaption(layer, style, temp) {
  if (!layer.caption) {
    const size = layer.fontSize * style.width / style.captions.width;
    const png = captionPng(layer.lines, style.width, style.height, size);
    const name = `caption-${layer.order}.png`;
    await fs.promises.writeFile(path.join(temp, name), png);
    layer.caption = name;
    layer.captionDigest = createHash('sha256').update(png).digest('hex');
  }
  return layer.caption;
}

async function previewSpanKey(window, style, temp) {
  if (window.layers.some(layer => layer.source && !layer.source.asset.sha256)) return null;
  const inputs = [];
  for (const layer of [...window.layers].sort((left, right) => left.order - right.order)) {
    if (layer.lines) {
      await renderCaption(layer, style, temp);
      inputs.push([layer.pictureStart, layer.pictureEnd, layer.captionDigest]);
    } else {
      const { source, kind, start, duration, in_point, volume, transition, split_duration, split_offset, pictureStart, pictureEnd } = layer;
      inputs.push([source.asset.sha256, source.asset.kind, source.info, kind, start, duration, in_point, volume, transition,
        split_duration, split_offset, pictureStart, pictureEnd]);
    }
  }
  return createHash('sha256').update(JSON.stringify([
    version, process.platform, process.arch, os.release(), style, window.firstFrame, window.end, inputs,
  ])).digest('hex');
}

const maxPreviewCacheBytes = 192 * 1024 ** 2;
const maxPreviewCacheSpans = 96;

async function previewCacheEntries(directory) {
  const entries = [];
  for (const name of await fs.promises.readdir(directory).catch(() => [])) {
    const match = /^([a-f0-9]{64})-([a-f0-9]{64})\.nut$/.exec(name);
    const temporary = /^pending-[a-f0-9-]{36}\.partial$/.test(name);
    if (!match && !temporary) continue;
    const file = path.join(directory, name);
    const stat = await fs.promises.lstat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    if (temporary) {
      if (Date.now() - stat.mtimeMs > 3600000) await fs.promises.rm(file, { force: true }).catch(() => {});
      continue;
    }
    entries.push({ file, key: match[1], digest: match[2], bytes: stat.size, lastUsed: stat.mtimeMs });
  }
  return entries.sort((left, right) => right.lastUsed - left.lastUsed);
}

async function reusePreviewSpan(cached, destination, signal) {
  if (!cached) return false;
  try {
    await fs.promises.copyFile(cached.file, destination, fs.constants.COPYFILE_FICLONE);
    if (await assetFingerprint(destination, signal) === cached.digest) {
      const now = new Date();
      await fs.promises.utimes(cached.file, now, now).catch(() => {});
      return true;
    }
    await fs.promises.rm(cached.file, { force: true }).catch(() => {});
  } catch {
    signal?.throwIfAborted();
  }
  await fs.promises.rm(destination, { force: true }).catch(() => {});
  return false;
}

async function savePreviewSpans(directory, spans, signal) {
  if (!spans.length) return;
  await fs.promises.mkdir(directory, { recursive: true });
  const entries = await previewCacheEntries(directory);
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  for (const { key, source } of spans) {
    signal?.throwIfAborted();
    const { size } = await fs.promises.stat(source);
    if (size > maxPreviewCacheBytes) continue;
    while (entries.length && (entries.length >= maxPreviewCacheSpans || bytes + size > maxPreviewCacheBytes)) {
      const oldest = entries.pop();
      await fs.promises.rm(oldest.file, { force: true });
      bytes -= oldest.bytes;
    }
    const digest = await assetFingerprint(source, signal);
    const destination = path.join(directory, `${key}-${digest}.nut`);
    const temporary = path.join(directory, `pending-${randomUUID()}.partial`);
    try {
      await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_FICLONE);
      signal?.throwIfAborted();
      await fs.promises.rename(temporary, destination);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
    entries.unshift({ file: destination, bytes: size });
    bytes += size;
  }
}

async function renderWindow(window, style, temp, output, { signal, preview, segmented, aliases, onProgress }) {
  const { width, height, fps, normalizeToBt709 } = style;
  const { firstFrame, end } = window;
  const start = firstFrame / fps;
  const duration = end - start;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-filter_complex_threads', '2',
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`,
    '-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=stereo:d=${duration}`];
  const parts = [`[0:v]setpts=PTS+${firstFrame}[base0]`];
  const audio = [];
  const inputIndexes = [];
  let video = '[base0]';
  const fit = `scale=w='max(2,trunc(min(${width},${height}*dar)/2)*2)':h='max(2,trunc(min(${height},${width}/dar)/2)*2)'`;
  for (const [position, layer] of [...window.layers].sort((left, right) => left.order - right.order).entries()) {
    signal?.throwIfAborted();
    const index = position + 2;
    if (layer.lines) {
      args.push('-threads', '1', '-i', await renderCaption(layer, style, temp));
      let caption = `[${index}:v]`;
      if (normalizeToBt709) {
        parts.push(`${caption}scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[caption${index}]`);
        caption = `[caption${index}]`;
      }
      parts.push(`${video}${caption}overlay=enable='${pictureIsActive(layer, fps)}'[base${index}]`);
      video = `[base${index}]`;
      continue;
    }
    const { asset, info } = layer.source;
    const isImage = asset.kind === 'image';
    let input = path.resolve(asset.path);
    const visibleLength = layer.kind === 'video'
      ? (Math.min(layer.pictureEnd, Math.round(end * fps) + 1) - layer.pictureStart) / fps : 0;
    const fadeDuration = layer.split_duration ?? layer.duration;
    const fadeOffset = layer.split_offset ?? 0;
    const splitVideo = !isImage && layer.split_duration != null;
    const inPoint = isImage ? 0 : Math.max(0, layer.in_point - fadeOffset);
    const frameOffset = layer.kind === 'video' ? layer.pictureStart - frameAtOrAfter(layer.start - fadeOffset, fps) : 0;
    const firstPicture = inPoint + (splitVideo ? frameOffset / fps : 0);
    args.push(...await renderSeek(layer, firstPicture, signal));
    if (window.layers.length > 6) args.push('-threads', '1');
    if (isImage) {
      // Use a loopable PNG for all still-image decoders, including AVIF and HEIC.
      if (!layer.source.still) {
        layer.source.still = `still-${layer.order}.png`;
        await createProxy(asset, path.join(temp, layer.source.still), signal, info);
      }
      input = layer.source.still;
      args.push('-loop', '1', '-framerate', String(fps), '-t', String(visibleLength));
    }
    args.push('-i', input);
    if (!isImage) inputIndexes.push(args.length - 1);
    const fade = layer.transition === 'fade' ? Math.min(0.35, fadeDuration / 2) : 0;
    if (layer.kind === 'video' && info.video) {
      // Keep the last preceding frame without resampling the entire prefix.
      const conformed = inPoint > 0
        ? `settb=AVTB,setpts='max(-ceil(1/(${fps}*TB)),PTS-${inPoint}/TB)',fps=${fps}:round=up`
        : `trim=start=0:duration=${visibleLength},fps=${fps}`;
      let sourceFrames = inPoint > 0 ? `${conformed},trim=start=0:end=${visibleLength}` : conformed;
      if (splitVideo) {
        // Conform a split on the original clip's frame grid, then take this portion.
        // Conforming each portion independently can repeat or skip a source frame.
        const original = pictureRange(layer.start - fadeOffset, fadeDuration, fps);
        const frames = Math.round(visibleLength * fps);
        const limit = Math.min(original.pictureEnd - original.pictureStart, frameOffset + frames + 1) / fps;
        const clock = inPoint > 0 ? conformed : `trim=start=0:duration=${limit},fps=${fps}`;
        sourceFrames = `${clock},trim=start_pts=${frameOffset}:end_pts=${frameOffset + frames},setpts=PTS-${frameOffset}`;
      }
      const preroll = Math.max(0, firstFrame - layer.pictureStart - 1) / fps;
      const windowTrim = preroll ? `trim=start=${preroll},` : '';
      const fadePicture = fade && (layer.split_duration != null || layer.pictureEnd - layer.pictureStart > 1);
      const fadeFilters = fadePicture ? [
        '', 'format=yuva420p', frameOffset ? `setpts=PTS+${frameOffset}` : null,
        `fade=t=in:st=0:d=${fade}:alpha=1`, `fade=t=out:st=${fadeDuration - fade}:d=${fade}:alpha=1`,
        frameOffset ? `setpts=PTS-${frameOffset}` : null,
      ].filter(value => value !== null).join(',') : '';
      let colorFilter = '';
      if (normalizeToBt709) {
        // Still layers come from RGB PNG proxies before compositing.
        const color = isImage ? { rgb: true } : info.color;
        const pixelFormat = (isImage || color.alpha) && !color.hdr ? 'yuva420p' : 'yuv420p';
        colorFilter = ',' + normalizeColor(color, { pixelFormat });
      }
      // Fades use the original clip clock, including when a render window starts mid-fade.
      parts.push(`[${index}:V:0]${sourceFrames},${fadePicture ? '' : windowTrim}${fit}${colorFilter},setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${fadeFilters},${fadePicture ? windowTrim : ''}setpts=PTS+${layer.pictureStart}[v${index}]`);
      parts.push(`${video}[v${index}]overlay=eof_action=pass:repeatlast=0:enable='${pictureIsActive(layer, fps)}'[base${index}]`);
      video = `[base${index}]`;
    }
    const sourceStart = Math.round(layer.start * sampleRate);
    const offset = sourceStart - firstFrame * (sampleRate / fps);
    if (info.audio && !isImage && offset < duration * sampleRate) {
      const label = `[a${index}]`;
      const audioLength = Math.min(layer.duration, end - sourceStart / sampleRate);
      const fadeSamples = Math.round(fadeOffset * sampleRate);
      const fadeAudio = fade ? [
        '', fadeSamples ? `asetpts=PTS+${fadeSamples}` : null,
        `afade=t=in:st=0:d=${fade}`, `afade=t=out:st=${fadeDuration - fade}:d=${fade}`,
        fadeSamples ? `asetpts=PTS-${fadeSamples}` : null,
      ].filter(value => value !== null).join(',') : '';
      const windowAudio = offset < 0 ? `atrim=start_sample=${-offset},asetpts=PTS-STARTPTS` : `adelay=${offset}S:all=1`;
      parts.push(`[${index}:a]atrim=start=${layer.in_point}:duration=${audioLength},asetpts=PTS-${layer.in_point}/TB,aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,volume=${layer.volume}${fadeAudio},${windowAudio}${label}`);
      audio.push(label);
    }
  }
  const mix = audio.length ? `[1:a]${audio.join('')}amix=inputs=${audio.length + 1}:duration=first:normalize=0,alimiter=limit=0.98:level=0:latency=1` : '[1:a]anull';
  parts.push(`${mix}[aout]`, `${video}setpts=PTS-${firstFrame}[vout]`);
  await fs.promises.writeFile(path.join(temp, 'filters.txt'), parts.join(';\n'));
  args.push('-filter_complex_script', 'filters.txt', '-map', '[vout]', '-map', '[aout]', '-t', String(duration),
    '-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'fast', '-crf', preview ? '27' : '19',
    '-pix_fmt', 'yuv420p', ...(normalizeToBt709 ? bt709Tags : []));
  // Keep audio PCM until the final mux to avoid adding AAC encoder padding at each join.
  args.push(...(segmented ? ['-bf', '0', '-x264-params', 'stitchable=1', '-c:a', 'pcm_s16le'] :
    ['-c:a', 'aac', '-movflags', '+faststart']), output);
  await shortenRenderInputs(args, inputIndexes, temp, aliases, signal);
  await execute(args, { cwd: temp, signal, onProgress });
}

async function exportVideo(project, options = {}) {
  const { signal, onProgress, preview = false, format = 'landscape', resolution = 720, fps = 30, output } = options;
  const dimensions = profiles[format];
  if (!dimensions) throw new Error('不支持该导出画幅');
  if (![720, 1080, 2160].includes(resolution)) throw new Error('不支持该导出分辨率');
  validateExportFrameRate(fps);
  const [width, height] = dimensions.map(dimension => preview ? dimension / 2 : dimension * resolution / 720);
  const clips = project.tracks.flatMap(track => track.clips.map(clip => ({ ...clip, kind: track.kind })));
  if (!clips.length) throw new Error('时间线为空');
  let duration = 0;
  for (const clip of clips) {
    timeNumber(clip.start, 0, 86400, '时间线起点');
    timeNumber(clip.in_point, 0, 86400, '素材入点');
    timeNumber(clip.duration, 0.04, 86400, '片段时长');
    timeNumber(clip.volume, 0, 4, '片段音量');
    if (clip.split_offset != null || clip.split_duration != null) {
      timeNumber(clip.split_duration, 0.04, 86400, '原片段时长');
      timeNumber(clip.split_offset, 0, clip.split_duration + 0.000001 - clip.duration, '拆分偏移');
    }
    duration = Math.max(duration, clip.start + clip.duration);
  }
  const style = {
    width, height, fps, captions: {
      width: dimensions[0], height: dimensions[1], fontSize: Math.min(...dimensions) * 0.0625,
    },
  };
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const used = new Set(clips.filter(clip => clip.kind !== 'subtitle').map(clip => clip.asset_id));
  const verifySources = async () => {
    for (const id of used) await requireAssetFile(assets.get(id), signal);
  };
  await verifySources();
  const layers = await prepareLayers(clips, assets, signal, style);
  style.normalizeToBt709 = layers.some(layer => layer.kind === 'video' && layer.source?.info.color.hdr);
  const frames = layers.reduce((latest, layer) => Math.max(latest, layer.pictureEnd ?? 0), frameAtOrAfter(duration, fps));
  duration = frames / fps;
  const windows = renderWindows(layers, duration, fps);
  const segmented = windows.length > 1;
  const cacheDirectory = preview && segmented ? path.join(project.dir, '.preview', 'spans-v1') : null;
  const cachedSpans = cacheDirectory ? await previewCacheEntries(cacheDirectory) : [];
  const cacheWrites = [];
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imodureel-render-'));
  const aliases = new Map();
  const destination = path.resolve(output || path.join(project.dir, 'exports', `iModuReel-${randomUUID()}.mp4`));
  const partial = destination + '.partial.mp4';
  let lastProgress = 0;
  const report = progress => {
    if (!Number.isFinite(progress) || progress <= lastProgress) return;
    lastProgress = progress;
    onProgress?.(progress);
  };
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const entries = [];
    for (const [index, window] of windows.entries()) {
      signal?.throwIfAborted();
      const start = window.firstFrame / fps;
      const span = window.end - start;
      const file = segmented ? `span-${index}.nut` : partial;
      const limit = segmented ? 0.94 : 0.99;
      const key = cacheDirectory ? await previewSpanKey(window, style, temp) : null;
      const cached = key && cachedSpans.find(entry => entry.key === key && entry.bytes <= maxPreviewCacheBytes);
      const source = key ? path.join(temp, file) : null;
      if (!await reusePreviewSpan(cached, source, signal)) {
        await renderWindow(window, style, temp, file, {
          signal, preview, segmented, aliases,
          onProgress: seconds => report(Math.min(limit, limit * (start + Math.min(span, seconds)) / duration)),
        });
        if (key) cacheWrites.push({ key, source });
      }
      // Round absolute boundaries to the concat demuxer's clock before taking the difference.
      if (segmented) {
        const micros = Math.round(window.end * 1e6) - Math.round(start * 1e6);
        entries.push(`file '${file}'`, `duration ${(micros / 1e6).toFixed(6)}`);
        report(limit * window.end / duration);
      }
    }
    if (segmented) {
      await fs.promises.writeFile(path.join(temp, 'spans.ffconcat'), ['ffconcat version 1.0', ...entries, ''].join('\n'));
      await execute(['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
        '-f', 'concat', '-safe', '1', '-i', 'spans.ffconcat', '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-t', String(duration), '-movflags', '+faststart', partial], {
        cwd: temp, signal, onProgress: seconds => report(Math.min(0.99, 0.94 + 0.05 * seconds / duration)),
      });
    }
    await verifySources();
    signal?.throwIfAborted();
    await fs.promises.rename(partial, destination);
    if (cacheDirectory) await savePreviewSpans(cacheDirectory, cacheWrites, signal).catch(() => {});
    report(1);
    return destination;
  } finally {
    await Promise.allSettled([fs.promises.rm(temp, { recursive: true, force: true }), fs.promises.rm(partial, { force: true })]);
  }
}

module.exports = {
  resolveFFmpeg, hasRenderFile, probe, createProxy, normalizeVideoRotation, detectScenes, extractAudio, extractFrame, exportVideo,
  enhancementBatchSize, enhancementVideoStart, splitEnhancement, rebuildEnhancementSegment, joinEnhancement,
  countVideoFrames, isBlackVideo, validateExportFrameRate,
};
