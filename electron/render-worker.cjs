const { fork } = require('node:child_process');

async function exportVideo(project, { signal, onProgress, ...options } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = fork(__filename, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result;
    let failure;
    let stderr = '';
    const cancel = () => { if (worker.connected) worker.send({ cancel: true }, () => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    worker.on('message', message => {
      if (typeof message.progress === 'number') onProgress?.(message.progress);
      else result = message;
    });
    worker.on('error', error => { failure = error; });
    worker.on('close', (code, reason) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (result?.error) return reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
      if (code === 0 && result?.file) return resolve(result.file);
      reject(new Error(stderr.trim() || `渲染进程已退出（${reason ?? code}），可重试任务`));
    });
    const failedToSend = error => {
      if (!error) return;
      failure = error;
      if (worker.connected) worker.disconnect();
    };
    try { worker.send({ project, options }, failedToSend); }
    catch (error) { failedToSend(error); }
  });
}

function run() {
  if (!process.connected) return;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('渲染已取消'));
  process.once('disconnect', cancel);
  // A hard exit closes the parent IPC channel. Keep this process alive until
  // FFmpeg has stopped and exportVideo has removed its unfinished files.
  let started = false;
  process.on('message', async request => {
    if (request.cancel) return cancel();
    if (started || controller.signal.aborted) return;
    started = true;
    let result;
    try {
      const file = await require('./media.cjs').exportVideo(request.project, {
        ...request.options, signal: controller.signal,
        onProgress: progress => { if (process.connected) process.send({ progress }, () => {}); },
      });
      result = { file };
    } catch (error) {
      result = { error: { message: error.message, code: error.code } };
    }
    if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
  });
}

if (require.main === module) run();

module.exports = { exportVideo };
