const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const engine = require('../electron/engine.cjs');
const services = require('../electron/services.cjs');
const { desktopSession } = require('./desktop-session.cjs');

const terminal = new Set(['done', 'failed', 'disconnected', 'cancelled', 'interrupted']);

async function press(session, label, selector = 'button') {
  await session.waitFor(() => session.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled);
    if (!button) {
      const error = document.querySelector('[role=alert]');
      if (error) throw new Error(error.textContent);
      return false;
    }
    button.click();
    return true;
  })()`), `未找到桌面操作：${label}`);
}

async function waitJob(session, project, timeout, select) {
  const deadline = Date.now() + timeout;
  try {
    return await session.waitFor(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let result;
      try {
        result = await session.callWithTimeout(Math.min(45000, remaining), 'project', project.id);
      } catch (error) {
        // A cold model load may stall one status read. The task deadline still applies.
        if (error.code !== 'DEVTOOLS_TIMEOUT') throw error;
        return;
      }
      const job = result.jobs.find(select);
      if (job) return job;
      await delay(350);
    }, `${project.name}任务未进入预期状态`, timeout);
  } catch (error) {
    throw new Error(`读取「${project.name}」的任务状态失败：${error.message}`, { cause: error });
  }
}

async function verifyEngineExit(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const closed = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(1000) })
      .then(() => false, error => error.cause?.code === 'ECONNREFUSED');
    if (closed) return;
    await delay(200);
  }
  throw new Error('桌面退出后，受管 ComfyUI 仍在监听原端口');
}

async function disconnectFirstSubmission(upstream) {
  const state = { submissions: 0, promptId: null };
  const relay = http.createServer(async (request, reply) => {
    const controller = new AbortController();
    reply.on('close', () => controller.abort());
    try {
      const { method, url } = request;
      const submit = method === 'POST' && url === '/prompt';
      const drop = submit && ++state.submissions === 1;
      const contentType = request.headers['content-type'];
      const response = await fetch(upstream + url, {
        method, signal: controller.signal,
        ...(contentType && { headers: { 'content-type': contentType } }),
        ...(!['GET', 'HEAD'].includes(method) && { body: request, duplex: 'half' }),
      });
      if (drop && response.ok) {
        const result = await response.json();
        assert.ok(result.prompt_id, 'ComfyUI 未返回已接受任务的编号');
        state.promptId = result.prompt_id;
        // Lose the reply only after the real instance has accepted the workflow.
        return reply.destroy();
      }
      const type = response.headers.get('content-type');
      reply.writeHead(response.status, type ? { 'content-type': type } : {});
      if (response.body) await pipeline(Readable.fromWeb(response.body), reply);
      else reply.end();
    } catch (error) {
      if (!reply.destroyed && !reply.headersSent) reply.writeHead(502).end(error.message);
      else reply.destroy();
    }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  return {
    url: 'http://127.0.0.1:' + relay.address().port, state,
    close: () => new Promise(resolve => {
      relay.close(resolve);
      relay.closeAllConnections();
    }),
  };
}

async function configureEngine(session, { engineDir, values, runs, timeout }) {
  const local = engineDir && !values['external-engine'];
  let connection;
  if (local && values['install-engine']) {
    const groups = values['install-models'] ? [...new Set(runs.map(({ bundle }) => bundle.id === 'reference-video' ? 'video' : bundle.id))] : [];
    const started = await session.evaluate(`(() => {
      const messages = [];
      const unsubscribe = window.api.on('engineLog', message => {
        messages.push(message);
        if (messages.length > 120) messages.shift();
      });
      window.readAcceptanceEngineLog = done => {
        if (done) {
          unsubscribe();
          delete window.readAcceptanceEngineLog;
        }
        return messages.splice(0).join('');
      };
      return true;
    })()`);
    assert.ok(started);
    const trace = async done => {
      const batch = await session.evaluate(`window.readAcceptanceEngineLog(${done})`).catch(() => '');
      if (batch) process.stdout.write(batch.replace(/^WARN Skipping file for .*\r?\n/gm, ''));
    };
    const logTimer = setInterval(() => { void trace(false); }, 3000);
    try {
      connection = await session.callWithTimeout(Math.max(timeout, 60 * 60000), 'setupLocalEngine', {
        dir: engineDir, groups, source: values['model-source'], packageIndex: values['package-index'], pythonMirror: values['python-mirror'],
      });
    } finally {
      clearInterval(logTimer);
      await trace(true);
    }
  } else if (local) {
    connection = await session.callWithTimeout(timeout, 'startEngine', engineDir);
  } else {
    const url = engineDir ? await engine.start(engineDir, text => process.stdout.write(text)) : services.baseUrl(values.url);
    connection = await session.callWithTimeout(timeout, 'connectExternalComfy', url);
  }
  assert.equal(connection.mode, local ? 'local' : 'external');
  const url = local ? connection.localUrl : connection.url;
  const response = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, '无法读取真实 ComfyUI 的运行环境');
  const { system, devices } = await response.json();
  if (engineDir) {
    const hardware = await session.call('engineInfo', engineDir);
    assert.ok(devices.some(device => device.type === hardware.backend.toLowerCase()), `ComfyUI 未使用 ${hardware.backend}`);
  }
  console.log(`桌面${local ? '受管' : '外部'}模式 · ComfyUI ${system.comfyui_version} · ${devices.map(device => device.type).join('、')}`);
  return { url, local };
}

async function prepareProject(session, run, { ai, reviewShot, timeout }) {
  const { template, project, bundle, inputs, details, reference } = run;
  await session.call('saveInputs', project.id, { ...inputs, ...details });
  await session.call('saveWorkflow', project.id, bundle.workflow, bundle.mapping);
  await session.call('saveExportSettings', project.id, 'portrait', 720, 30);
  if (template.id === 'enhance') return null;
  let suggested;
  if (ai) {
    const { analysis, shots } = await session.callWithTimeout(timeout, 'analyze', project.id);
    assert.ok(analysis.summary.trim() && shots[0]?.prompt);
    if (reference) {
      assert.ok(analysis.sceneCuts.length, '参考视频没有返回镜头时间');
      assert.ok(analysis.referenceSources, '参考视频没有记录分析依据');
      const { script, frames, transcription } = analysis.referenceSources;
      if (frames && !script && !['used', 'partial'].includes(transcription)) {
        assert.ok(shots.every(shot => shot.dialogue === ''), '仅使用抽帧时，初次分析中的对白应留空');
      }
    }
    if (template.id === 'fashion' && ai.vision) assert.ok(analysis.productAppearance, '商品视觉分析没有返回外观字段');
    await session.call('saveAnalysis', project.id, {
      ...analysis, summary: analysis.summary + '\n审核补充：保持镜头运动平稳。',
    });
    [suggested] = await session.callWithTimeout(timeout, 'suggestShots', project.id);
    await session.call('useAnalysisShots', project.id);
    console.log(`${project.name}的真实 AI 分析与修订通过`);
  }
  const [reviewed] = await session.call('approveShots', project.id, [reviewShot(suggested)]);
  return reviewed;
}

async function verifyDesktopTemplates(config) {
  const { desktop, profile, ai, runs, engineDir, values, checkTimeline, checkOutput, checkExport, saveSamples } = config;
  const timeout = config.timeout * 1000;
  const restored = [];
  const managed = engineDir && !values['external-engine'];
  let active;
  let disconnect;
  let checkJobs = values['job-checks'];
  try {
    await desktopSession(desktop, [], profile, async session => {
      try {
        const connection = await configureEngine(session, { ...config, timeout });
        if (checkJobs && !connection.local) {
          disconnect = await disconnectFirstSubmission(connection.url);
          await session.call('connectExternalComfy', disconnect.url);
          connection.url = disconnect.url;
        }
        if (ai) assert.ok((await session.call('saveAI', ai)).hasKey);
        for (const run of runs) {
          const { project, bundle } = run;
          const reviewed = await prepareProject(session, run, { ...config, timeout });
          const checkThisJob = checkJobs && Boolean(reviewed);
          if (checkThisJob) await config.verifyPreflight((...args) => session.call('preflight', ...args), bundle);
          await session.openProject(project.name);
          if (run.reference) {
            await press(session, '分析与分镜', 'nav button');
            await session.waitFor(() => session.evaluate("document.body.innerText.includes('本次分析使用了')"),
              '分析页没有显示参考视频的分析依据');
          }
          const generationTab = reviewed ? '镜头生成' : '画质增强';
          await press(session, generationTab, 'nav button');
          if (reviewed) await press(session, '全选');
          await press(session, reviewed ? '生成所选镜头（1）' : '开始增强');
          const submitted = await waitJob(session, project, timeout, job => job.kind === 'comfy');
          active = { project, id: submitted.id };
          const target = JSON.parse(submitted.detail);
          if (reviewed) assert.ok(target.values.prompt.startsWith(reviewed.prompt));
          if (connection.local) assert.equal(path.resolve(target.engineDir), engineDir);
          else assert.equal(target.url, connection.url);
          if (checkThisJob && disconnect) {
            const interrupted = await waitJob(session, project, timeout, job => job.id === active.id && terminal.has(job.status));
            assert.equal(interrupted.status, 'disconnected', interrupted.detail);
            assert.match(JSON.parse(interrupted.detail).error, /连接中断.*恢复任务/);
            assert.ok(disconnect.state.promptId, '断开连接前应由真实 ComfyUI 接受任务');
            await press(session, '任务', 'nav button');
            await press(session, '恢复任务');
            await waitJob(session, project, timeout, job => job.id === active.id && job.status !== 'disconnected');
          } else if (checkThisJob) {
            const running = await waitJob(session, project, timeout, job => job.id === active.id && (job.status === 'running' || terminal.has(job.status)));
            assert.equal(running.status, 'running', running.detail);
            assert.equal((await session.callWithTimeout(timeout, 'cancelJob', running.id)).status, 'cancelled');
            await assert.rejects(services.waitPrompt(connection.url, running.prompt_id, {
              signal: AbortSignal.timeout(timeout),
            }), /execution_interrupted/);
            active.id = (await session.call('retryJob', running.id)).id;
            console.log('桌面任务缺节点、缺模型、定向取消和重试通过');
          }
          if (checkThisJob) checkJobs = false;
          const completed = await waitJob(session, project, timeout, job => job.id === active.id && terminal.has(job.status));
          assert.equal(completed.status, 'done', completed.detail);
          active = null;
          const result = await session.call('project', project.id);
          const output = await checkOutput(result, completed, run, 4);
          if (checkThisJob && disconnect) {
            assert.equal(completed.prompt_id, disconnect.state.promptId);
            assert.equal(disconnect.state.submissions, 1, '恢复任务重复提交了工作流');
            assert.equal(result.jobs.filter(job => job.kind === 'comfy').length, 1);
            console.log('桌面任务缺节点、缺模型及断线恢复通过，原任务产物已入库且仅提交一次');
          }
          await press(session, generationTab, 'nav button');
          if (reviewed) {
            await press(session, '按分镜顺序追加粗剪');
          } else {
            const track = await session.call('addTrack', project.id, 'video', '素材轨');
            await assert.rejects(session.call('addClip', track.id, { asset_id: output.id }), /请在(?:增强结果中确认|生成页重新确认增强结果)/);
            await press(session, '确认增强结果');
            await press(session, '加入时间线');
          }
          await press(session, '生成合成预览');
          const preview = await waitJob(session, project, timeout, job => job.kind === 'preview' && terminal.has(job.status));
          assert.equal(preview.status, 'done', preview.detail);
          await session.waitFor(() => session.evaluate(`(() => {
            const player = document.querySelector('video');
            return player?.getAttribute('src') === ${JSON.stringify('media://render/' + preview.id)} &&
              player.readyState >= 2 && player.videoWidth === 360 && player.videoHeight === 640;
          })()`), `${project.name}的合成预览未能播放`);
          await press(session, '导出 MP4');
          const exported = await waitJob(session, project, timeout, job => job.kind === 'export' && terminal.has(job.status));
          assert.equal(exported.status, 'done', exported.detail);
          await checkExport(JSON.parse(exported.detail).file, reviewed?.duration);
          restored.push({ run, reviewed, completed, output, exported });
          console.log(`${project.name}从桌面生成、入库并导出 MP4`);
        }
        if (connection.local) {
          await session.forceQuit();
          await verifyEngineExit(connection.url);
        } else await session.quit();
      } catch (error) {
        if (active) await session.call('cancelJob', active.id).catch(() => {});
        await session.quit().catch(() => {});
        throw error;
      }
    });
    let restartedUrl;
    await desktopSession(desktop, [], profile, async session => {
      const { comfy } = await session.call('settings');
      assert.equal(comfy.mode, managed ? 'local' : 'external');
      for (const { run, completed, output, reviewed, exported } of restored) {
        const project = await session.call('project', run.project.id);
        checkTimeline(project, completed, output, reviewed);
        assert.equal(project.jobs.find(job => job.id === exported.id)?.status, 'done');
        const response = await session.evaluate(`fetch(${JSON.stringify('media://render/' + exported.id)}, {
          headers: { Range: 'bytes=0-31' },
        }).then(async response => [response.status, (await response.arrayBuffer()).byteLength])`);
        assert.deepEqual(response, [206, 32]);
        saveSamples(run, output, JSON.parse(exported.detail).file, project, reviewed);
      }
      if (managed) restartedUrl = (await session.callWithTimeout(timeout, 'startEngine', engineDir)).localUrl;
      await session.quit();
    });
    if (restartedUrl) {
      await verifyEngineExit(restartedUrl);
      console.log('强制终止与正常退出均关闭受管 ComfyUI，重开应用后可从原目录启动');
    }
    console.log(`桌面重启后恢复 ${restored.length} 个项目、时间线、生成产物和已导出的成片`);
  } finally {
    try {
      if (disconnect) await disconnect.close();
    } finally {
      if (values['external-engine']) await engine.stop();
    }
  }
}

module.exports = { verifyDesktopTemplates };
