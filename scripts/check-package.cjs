const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const target = process.argv[2];

const architectures = { darwin: ['arm64', 'x64'], win32: ['x64'] };
if (process.platform !== target || !architectures[target]?.includes(process.arch)) {
  console.error(`请在 ${target}/${architectures[target]?.join(' 或 ') ?? '受支持的架构'} 上构建此平台的安装包。`);
  process.exit(1);
}
const ffmpeg = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), target === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const command = target === 'darwin'
  ? ['/usr/bin/arch', process.arch === 'arm64' ? '-arm64' : '-x86_64', ffmpeg]
  : [ffmpeg];
const check = option => fs.existsSync(ffmpeg) && spawnSync(command[0], [...command.slice(1), '-hide_banner', option], {
  encoding: 'utf8', timeout: 10000, windowsHide: true,
});
const filters = check('-filters');
if (filters?.status !== 0) {
  console.error('缺少当前目标平台可执行的 FFmpeg。请完成依赖安装后再打包。');
  process.exit(1);
}
const availableFilters = new Set(filters.stdout.split('\n').map(line => line.trim().split(/\s+/)[1]));
if (!['zscale', 'tonemap'].every(name => availableFilters.has(name))) {
  console.error('当前 FFmpeg 缺少 HDR 色彩转换所需的 zscale 或 tonemap。请检查目标平台的 FFmpeg 依赖。');
  process.exit(1);
}
if (!availableFilters.has('blackframe')) {
  console.error('当前 FFmpeg 缺少动态镜头校验所需的 blackframe。请检查目标平台的 FFmpeg 依赖。');
  process.exit(1);
}
const bitstreamFilters = check('-bsfs');
if (bitstreamFilters?.status !== 0 || !bitstreamFilters.stdout.split(/\r?\n/).includes('h264_metadata')) {
  console.error('当前 FFmpeg 缺少写入增强视频显示比例所需的 h264_metadata。请检查目标平台的 FFmpeg 依赖。');
  process.exit(1);
}
try {
  const { Resvg } = require('@resvg/resvg-js');
  new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').render();
  const electron = spawnSync(require('electron'), ['-p', 'process.arch'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (electron.status !== 0 || electron.stdout.trim() !== process.arch) throw new Error('Electron 架构与打包环境不一致');
} catch (error) {
  console.error(`原生依赖检查失败，请在目标架构下重新安装依赖。\n${error.message}`);
  process.exit(1);
}
