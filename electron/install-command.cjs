const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const commandDirectory = directory => path.join(directory, '.install-commands');

async function waitForPreviousCommands(directory, signal) {
  const markers = commandDirectory(directory);
  const deadline = Date.now() + 5000;
  while (true) {
    signal.throwIfAborted();
    const names = await fs.promises.readdir(markers).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let active = false;
    for (const name of names.filter(name => /^[1-9][0-9]{0,9}$/.test(name))) {
      const pid = Number(name);
      if (pid > 2147483647) continue;
      try {
        process.kill(pid, 0);
        active = true;
      } catch (error) {
        if (error.code === 'EPERM') active = true;
        else if (error.code === 'ESRCH') await fs.promises.rm(path.join(markers, name), { force: true });
        else throw error;
      }
    }
    if (!active) return;
    if (Date.now() >= deadline) throw new Error('上一次安装仍在使用该目录，请等待安装进程退出后重试');
    await delay(100, undefined, { signal });
  }
}

function command(binary, args, directory, { signal, env = process.env, emit } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [binary, ...args], {
      cwd: directory, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [],
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let tail = '';
    let spawnError;
    const send = message => { if (child.connected) child.send(message, () => {}); };
    const cancel = () => send('cancel');
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', error => { spawnError = error; });
    child.on('message', message => { if (message === 'ready') send(signal?.aborted ? 'cancel' : 'start'); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', buffer => {
      tail = (tail + buffer).slice(-5000);
      emit?.(buffer.toString());
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) return reject(signal.reason);
      if (spawnError) return reject(spawnError);
      return code === 0 ? resolve(tail) : reject(new Error(tail || `${path.basename(binary)} 退出码 ${code}`));
    });
  });
}

function supervise([binary, ...args]) {
  if (!process.connected) return;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const markers = commandDirectory(process.cwd());
  const marker = path.join(markers, String(process.pid));
  fs.mkdirSync(markers, { recursive: true });
  fs.writeFileSync(marker, '');
  const windows = process.platform === 'win32';
  let child;
  let stopping = false;
  let finished = false;

  function finish(code) {
    if (finished) return;
    finished = true;
    process.off('message', onMessage);
    process.off('disconnect', cancel);
    fs.rmSync(marker, { force: true });
    if (process.connected) process.disconnect();
    process.exitCode = code ?? 1;
  }

  function cancel() {
    if (!child) return finish(1);
    if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    if (windows) {
      const system = process.env.SystemRoot || process.env.windir;
      const taskkill = system ? path.join(system, 'System32', 'taskkill.exe') : 'taskkill.exe';
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.on('exit', code => { if (code !== 0) child.kill(); });
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }

  function onMessage(message) {
    if (message === 'cancel') return cancel();
    if (message !== 'start' || child) return;
    child = spawn(binary, args, { windowsHide: true, detached: !windows, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', error => process.stderr.write(error.message + '\n'));
    child.on('close', finish);
  }
  process.on('message', onMessage);
  process.once('disconnect', cancel);
  // The owner acknowledges the marker before the installation can modify any files.
  process.send('ready', error => { if (error) cancel(); });
}

if (require.main === module) supervise(process.argv.slice(2));

module.exports = { command, waitForPreviousCommands };
