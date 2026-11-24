const { execFile } = require('node:child_process');
const { win32 } = require('node:path');
const { promisify } = require('node:util');

// NVIDIA's Windows minimum for CUDA 12.x minor-version compatibility.
const minimumDriver = '528.33';
const [minimumMajor, minimumMinor] = minimumDriver.split('.').map(Number);
const gpuUUID = /^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function parseGpu(line) {
  const fields = line.split(',');
  const uuid = fields.shift()?.trim();
  const capability = fields.pop()?.trim();
  const driverVersion = fields.pop()?.trim();
  const memoryMiB = Number(fields.pop());
  const name = fields.join(',').trim().replace(/^"|"$/g, '');
  if (!name || !/^\d+\.\d+(?:\.\d+)*$/.test(driverVersion)) return null;
  return {
    name, memoryMiB, driverVersion, uuid: gpuUUID.test(uuid) ? uuid : null,
    capability: /^\d+\.\d+$/.test(capability) ? capability : null,
  };
}

async function nvidiaInfo({
  env = process.env,
  run = promisify(execFile),
} = {}) {
  const system = env.SystemRoot || env.windir;
  const programs = env.ProgramW6432 || env.ProgramFiles;
  const binaries = [
    system && win32.isAbsolute(system) && win32.join(system, 'System32', 'nvidia-smi.exe'),
    programs && win32.isAbsolute(programs) && win32.join(programs, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    'nvidia-smi.exe',
  ].filter(Boolean);

  for (const binary of binaries) {
    let stdout;
    try {
      ({ stdout } = await run(binary, [
        '--query-gpu=uuid,name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits',
      ], { timeout: 5000, windowsHide: true }));
    } catch {
      continue;
    }
    const devices = stdout.trim().split(/\r?\n/).map(parseGpu).filter(Boolean);
    if (!devices.length) continue;
    const { driverVersion } = devices[0];
    const [major, minor] = driverVersion.split('.').map(Number);
    if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
      return {
        supported: false, driverVersion,
        name: `检测到 NVIDIA 驱动 ${driverVersion}，请升级至 ${minimumDriver} 或更新版本后安装 CUDA 本地引擎`,
      };
    }
    // The pinned PyTorch 2.8 CUDA 12.8 wheels dropped Maxwell and Pascal.
    const compatible = devices.find(device => Number(device.capability) >= 7);
    const usable = compatible ?? devices.find(device => device.capability === null);
    if (!usable) return {
      supported: false, driverVersion,
      name: `当前 CUDA 本地引擎需要计算能力至少为 7.0 的显卡。检测到 ${devices.map(device => `${device.name}（${device.capability}）`).join('、')}，可改用已有 ComfyUI 实例`,
    };
    const { name, memoryMiB } = usable;
    const details = Number.isFinite(memoryMiB) && memoryMiB > 0 ? `${name} · ${memoryMiB} MiB` : name;
    const mixed = devices.some(device => device.capability !== null && Number(device.capability) < 7);
    const deviceUUID = mixed && compatible?.uuid;
    return { supported: true, backend: 'CUDA', name: details, driverVersion, ...(deviceUUID && { deviceUUID }) };
  }
  return { supported: false, name: '未检测到可用的 NVIDIA GPU 或驱动，请检查 NVIDIA 驱动安装' };
}

function cudaRuntimeEnv(hardware, env = process.env) {
  if (!hardware.deviceUUID || Object.keys(env).some(key => key.toUpperCase() === 'CUDA_VISIBLE_DEVICES')) return env;
  return { ...env, CUDA_VISIBLE_DEVICES: hardware.deviceUUID };
}

module.exports = { nvidiaInfo, cudaRuntimeEnv };

if (require.main === module) {
  nvidiaInfo().then(info => {
    console.log(JSON.stringify(info));
    if (!info.supported) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
