const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function desktopSession(executable, appArgs, profile, verify, { env = process.env } = {}) {
  // Preview builds use an isolated test keychain to avoid prompts from macOS during upgrades.
  const keychain = process.platform === 'darwin' && !appArgs.includes('--use-mock-keychain') ? ['--use-mock-keychain'] : [];
  const child = spawn(executable, [...appArgs, ...keychain, '--user-data-dir=' + profile, '--remote-debugging-port=0'], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  let socket;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000); });
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  let failure;
  child.on('error', error => { failure = error; });

  async function waitFor(read, message = 'Electron smoke test timed out', timeout = 22500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !exited) {
      if (failure) throw failure;
      const result = await read();
      if (result) return result;
      await delay(150);
    }
    if (failure) throw failure;
    throw new Error(message + ': ' + stderr);
  }

  try {
    const devTools = await waitFor(() => /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1]);
    const url = 'http://' + new URL(devTools).host + '/json/list';
    const page = await waitFor(async () => {
      const targets = await fetch(url, { signal: AbortSignal.timeout(1000) })
        .then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page' && target.url.includes('index.html'));
    });
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await Promise.race([
      once(socket, 'open', { signal: AbortSignal.timeout(5000) }),
      closed.then(() => { throw new Error('Electron exited while connecting DevTools: ' + stderr); }),
    ]);
    let request = 0;
    const callbacks = new Map();
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      callbacks.get(response.id)?.finish(response);
      callbacks.delete(response.id);
    });
    socket.addEventListener('close', () => {
      const error = new Error('Electron disconnected before completing the desktop check: ' + stderr);
      for (const callback of callbacks.values()) callback.fail(error);
      callbacks.clear();
    });
    const devToolsCall = (method, params = {}, timeout = 10000) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Electron DevTools connection is closed'));
      const id = ++request;
      const timer = setTimeout(() => {
        callbacks.delete(id);
        reject(Object.assign(new Error(`Electron DevTools request timed out: ${method}`), { code: 'DEVTOOLS_TIMEOUT' }));
      }, timeout).unref();
      callbacks.set(id, {
        finish(response) {
          clearTimeout(timer);
          if (response.error) reject(new Error(JSON.stringify(response.error)));
          else resolve(response.result);
        },
        fail(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        callbacks.get(id).fail(error);
        callbacks.delete(id);
      }
    });
    const evaluate = async (expression, timeout) => {
      const response = await devToolsCall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    async function callWithTimeout(timeout, ...args) {
      const response = await evaluate(`window.api.call(...${JSON.stringify(args)})`, timeout);
      if (!response.ok) throw new Error(response.error || 'Electron IPC failed');
      return response.data;
    }
    const call = (...args) => callWithTimeout(undefined, ...args);
    async function openProject(name) {
      const label = JSON.stringify(name);
      await waitFor(() => evaluate(`(() => {
        const button = [...document.querySelectorAll('aside button')]
          .find(item => item.textContent.trim() === ${label} && !item.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`), '未找到项目 ' + name);
      await waitFor(() => evaluate(
        `document.querySelector('header strong')?.textContent === ${label} && Boolean(document.querySelector('nav'))`,
      ), '未打开项目 ' + name);
    }
    async function quit() {
      const browser = new WebSocket(devTools);
      await once(browser, 'open', { signal: AbortSignal.timeout(5000) });
      browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Application did not quit after saving edits')), 15000).unref();
        })]);
        if (child.exitCode !== 0) throw new Error('Application exited with code ' + child.exitCode + ': ' + stderr);
      } finally {
        browser.close();
      }
    }
    async function forceQuit() {
      if (!child.kill('SIGKILL')) throw new Error('Could not terminate the test application');
      await closed;
    }
    await waitFor(() => evaluate("Boolean(window.api && document.body?.innerText.includes('短剧制作'))"));
    return await verify({ evaluate, call, callWithTimeout, devToolsCall, waitFor, openProject, quit, forceQuit });
  } finally {
    socket?.close();
    if (!exited) {
      child.kill();
      await Promise.race([closed, delay(3000, undefined, { ref: false })]);
      if (!exited) child.kill('SIGKILL');
    }
    await closed;
  }
}

module.exports = { desktopSession };
