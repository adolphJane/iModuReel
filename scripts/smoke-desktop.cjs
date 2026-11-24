const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const assert = require('node:assert/strict');
const store = require('../electron/store.cjs');
const { buildGeneration, templates } = require('../electron/templates.cjs');
const { preset } = require('../electron/presets.cjs');
const { probe, resolveFFmpeg } = require('../electron/media.cjs');
const { desktopSession } = require('./desktop-session.cjs');
const { installDesktopPackage, installedArchive } = require('./desktop-package.cjs');

async function verifyTextOnlyFashion(project, image, { call }) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks));
    const analysis = {
      summary: '纯文字商品分析', characters: [], scenes: [],
      shots: [{ title: '开场', prompt: 'Blue coat', duration: 1, dialogue: '', scene: '', characters: [] }],
    };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { model: 'smoke-test', url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'desktop-smoke-test-key' };
    await call('saveAI', { ...config, vision: false });
    const { analysis } = await call('analyze', project.id);
    assert.equal(analysis.summary, '纯文字商品分析');
    assert.equal((await call('project', project.id)).production.inputs.productImage, image.id);
    await call('saveAI', { ...config, vision: true });
    await assert.rejects(call('analyze', project.id), /重新选择或定位项目素材/);
    assert.equal(requests.length, 1);
    const { messages } = JSON.parse(requests[0]);
    assert.deepEqual(JSON.parse(messages[1].content), { product: '蓝色外套', sellingPoints: '防风' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('关闭视觉后商品图缺失不影响纯文本分析，开启视觉后仍提示重新定位');
}

async function verifyAnalysisRevision(project, { call, waitFor, evaluate, openProject }) {
  const projectId = project.id;
  const template = JSON.parse(project.template_snapshot);
  let reply;
  let requests = 0;
  let cancelled = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.ok(body.messages[0].content.startsWith(template.analysisPrompt));
      const { script } = JSON.parse(body.messages[1].content);
      requests++;
      const sendAnalysis = () => {
        const analysis = {
          summary: script, characters: [], scenes: [],
          shots: [{ title: script, prompt: script, duration: 4, dialogue: '', scene: '', characters: [] }],
        };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
        reply = null;
      };
      reply = sendAnalysis;
      response.once('close', () => {
        if (!response.writableFinished) cancelled++;
        if (reply === sendAnalysis) reply = null;
      });
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
    const config = { model: 'smoke-test' };
    await call('saveInputs', projectId, { script: '旧剧本' });
    await call('saveAI', { ...config, url: endpoint + '/previous', apiKey: 'desktop-smoke-test-key' });
    const changed = await call('saveAI', { ...config, url: endpoint });
    assert.equal(changed.hasKey, false, 'Switching an AI endpoint must drop the previous key');
    await assert.rejects(call('analyze', projectId), /请先设置 AI/);
    assert.equal(requests, 0);
    await call('saveAI', { ...config, url: endpoint, apiKey: 'new-smoke-test-key' });
    assert.equal((await call('saveAI', { ...config, url: endpoint + '/' })).hasKey, true);

    const analyze = () => evaluate(`window.api.call('analyze', ${JSON.stringify(projectId)})`);
    const previous = analyze();
    await waitFor(() => reply);
    await call('saveInputs', projectId, { script: '新剧本' });
    reply();
    assert.match((await previous).error, /分析期间输入或分析内容已修改/);
    assert.equal((await call('project', projectId)).production.analysis, undefined);
    const current = analyze();
    await waitFor(() => reply);
    reply();
    assert.equal((await current).ok, true);
    await openProject(project.name);
    assert.ok(await evaluate(`document.querySelector('.page > p')?.textContent === ${JSON.stringify(template.description)}`),
      '工作台应显示项目保存的模板说明');
    await waitFor(() => evaluate(`(() => {
      const button = [...document.querySelectorAll('nav button')].find(item => item.textContent === '分析与分镜');
      return button && (button.click(), true);
    })()`));
    await waitFor(() => evaluate(`document.querySelector('.page h1')?.textContent === '分析与分镜'`));
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('fieldset[aria-label="分析输入"] > label'))
      .map(label => label.firstChild.textContent)`), ['文字剧本']);
    assert.deepEqual((await call('project', projectId)).template, template);
    assert.deepEqual((await call('presets', projectId)).map(item => item.id), ['video', 'still']);
    const reference = preset('drama', 'reference-video');
    await assert.rejects(call('preflight', reference.workflow, reference.mapping, projectId), /不包含 referenceImage 输入/);
    const snapshot = (await call('project', projectId)).production;
    const click = label => waitFor(() => evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.matches(':disabled')) return false;
      const confirm = window.confirm;
      try {
        window.confirm = () => true;
        button.click();
        return true;
      } finally {
        window.confirm = confirm;
      }
    })()`));
    await click('AI 分析');
    await waitFor(() => reply);
    await waitFor(() => evaluate('document.querySelector(\'fieldset[aria-label="编辑分析结果"]\')?.disabled'));
    await click('取消 AI 分析');
    await waitFor(() => cancelled === 1, 'AI 取消没有中止 HTTP 请求');
    await waitFor(() => evaluate("document.querySelector('[role=status]')?.textContent === 'AI 分析已取消。'"));
    assert.deepEqual((await call('project', projectId)).production, snapshot);
    await click('AI 分析');
    await waitFor(() => reply);
    reply();
    await waitFor(() => evaluate("document.querySelector('[role=status]')?.textContent === '分析建议已生成。'"));
    const shots = await call('useAnalysisShots', projectId);
    assert.equal(shots[0].prompt, '新剧本');
    await call('approveShots', projectId, shots);
    await click('添加场次');
    await waitFor(() => evaluate(`(() => {
      const title = [...document.querySelectorAll('label')].find(label => label.textContent === '场次 1')?.querySelector('input');
      if (!title) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, '审核补充场次');
      title.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await click('保存分析修改');
    await waitFor(async () => (await call('project', projectId)).production.analysis.scenes[0]?.title === '审核补充场次');
    await click('移除场次 1');
    await click('保存分析修改');
    await waitFor(async () => (await call('project', projectId)).production.analysis.scenes.length === 0);
    const editSummary = value => waitFor(() => evaluate(`(() => {
      const summary = document.querySelector('fieldset[aria-label="编辑分析结果"] textarea');
      if (!summary) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(summary, ${JSON.stringify(value)});
      summary.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await editSummary('');
    const emptySummary = await evaluate(`new Promise(resolve => requestAnimationFrame(() =>
      resolve(document.querySelector('fieldset[aria-label="编辑分析结果"] textarea')?.value ?? null)))`);
    assert.equal(emptySummary, '', '清空最后一个摘要后仍应显示分析编辑区');
    await click('保存分析修改');
    await waitFor(async () => (await call('project', projectId)).production.analysis.summary === '');
    await editSummary('修订后的摘要');
    await click('保存分析修改');
    await waitFor(async () => (await call('project', projectId)).production.analysis.summary === '修订后的摘要');
    await call('saveInputs', projectId, { script: '第三版剧本' });
    await assert.rejects(call('useAnalysisShots', projectId), /当前输入和分析/);
    const updated = await call('project', projectId);
    assert.notEqual(updated.production.inputRevision, updated.production.reviewedInputRevision);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyEngineSetup({ clickButton, call, waitFor, evaluate, openProject }, workflowProject) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/object_info') response.end(JSON.stringify({
      AvailableOutput: { input: { required: { text: ['STRING', {}] } }, output: [], output_node: true },
    }));
    else response.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { comfy, engine } = await call('settings');
    assert.equal(comfy.configured, false);
    const plan = await call('engineSetupPlan', engine.dir);
    assert.equal(plan.groups.length, 3);
    await clickButton('连接或安装 ComfyUI');
    await waitFor(() => evaluate(`[...document.querySelectorAll('details button')]
      .some(button => button.textContent.trim() === '导出 MPS 兼容节点')`));
    await clickButton('本地安装');
    await waitFor(() => evaluate(plan.supported
      ? 'document.body.innerText.includes("安装所需模板模型")'
      : 'document.body.innerText.includes("改用已有 ComfyUI")'));
    if (plan.supported) {
      await waitFor(() => evaluate(`document.getElementById('engine-directory')?.value === ${JSON.stringify(engine.dir)}`));
      await clickButton('连接已有 ComfyUI');
      // Use a mismatched source marker to test the repair entry point without downloading dependencies.
      const source = path.join(engine.dir, 'ComfyUI');
      const uv = path.join(engine.dir, '.uv', process.platform === 'win32' ? 'uv.exe' : 'uv');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(path.dirname(uv), { recursive: true });
      fs.writeFileSync(uv, '');
      fs.writeFileSync(path.join(source, '.imodureel-revision'), 'unverified source');
      fs.writeFileSync(path.join(engine.dir, 'installation.json'), JSON.stringify({
        revision: '265adad858e1f31b66cd3523a02b16f5d34ced52', python: '3.12.12', state: 'repairing',
      }));
      await clickButton('本地安装');
      await waitFor(() => evaluate('document.body.innerText.includes("运行环境待继续修复")'));
      await clickButton('仅继续修复运行环境');
      await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent?.includes("受管引擎版本不匹配")'));
      assert.equal((await call('settings')).comfy.configured, false);
    }
    await clickButton('连接已有 ComfyUI');
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    async function address(value) {
      await waitFor(() => evaluate(`(() => {
        const input = document.querySelector('input[type="url"]');
        if (!input) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`));
    }
    await address(endpoint + '/unavailable');
    await clickButton('测试并连接');
    await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent?.includes("HTTP 404")'));
    assert.equal((await call('settings')).comfy.configured, false);
    await address(endpoint);
    await clickButton('测试并连接');
    const connected = await waitFor(async () => {
      const updated = (await call('settings')).comfy;
      return updated.configured && updated;
    });
    assert.equal(connected.url, endpoint);
    await clickButton('项目首页');
    await waitFor(() => evaluate('document.body.innerText.includes("创建视频项目") && !document.body.innerText.includes("连接或安装 ComfyUI")'));

    const workflow = { '1': { class_type: 'AvailableOutput', inputs: { text: '' } } };
    const mapping = { prompt: { node: '1', input: 'text' } };
    await call('saveWorkflow', workflowProject.id, workflow, mapping);
    await assert.rejects(call('saveWorkflow', workflowProject.id, workflow, {}), /必须绑定 prompt/);
    assert.deepEqual(await call('loadWorkflow', workflowProject.id), { workflow, mapping });
    await openProject(workflowProject.name);
    await clickButton('镜头生成');
    await waitFor(() => evaluate('document.querySelector("textarea.code-field")?.value.includes("AvailableOutput")'));
    const edited = JSON.stringify({ '1': { class_type: 'MissingOutput', inputs: { text: '' } } });
    await evaluate(`(() => {
      const field = document.querySelector('textarea.code-field');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(edited)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickButton('预检工作流');
    await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent?.includes("MissingOutput")'));
    assert.deepEqual(await call('loadWorkflow', workflowProject.id), { workflow, mapping });
    await waitFor(async () => (await call('project', workflowProject.id)).editorDrafts.workflow?.workflow === edited);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function createLinkedTimeline(directory) {
  const project = store.createProject('Linked timeline', path.join(directory, 'linked timeline'), templates[0]);
  const colors = ['red', 'blue'];
  const shots = store.setShots(project.id, colors.map(color => ({
    title: color, prompt: color, duration: 1, dialogue: color + ' dialogue',
  })), true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  for (const [index, color] of colors.entries()) {
    const source = path.join(directory, color + '.png');
    execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=${color}:s=64x64`, '-frames:v', '1', source]);
    const [payload] = buildGeneration(store.project(project.id), bundle, 'http://127.0.0.1:8188', [shots[index].id]);
    const job = store.addJob(project.id, 'comfy', payload);
    const [asset] = await store.addMedia(project.id, [{ src: source, kind: 'image', origin: 'comfy', jobId: job.id }]);
    store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [asset.id] }) });
  }
  await store.appendStoryboard(project.id);
  return project;
}

async function createQueuedGeneration(directory) {
  const project = store.createProject('Generation queue', path.join(directory, 'generation queue'), templates[1]);
  const [asset] = await store.addMedia(project.id, [{ src: path.join(directory, 'red.png'), kind: 'image' }]);
  store.saveInputs(project.id, 'fashion', { productImage: asset.id });
  store.setShots(project.id, [{ title: 'Opening', prompt: 'Opening' }, { title: 'Detail', prompt: 'Detail' }], true);
  store.saveWorkflow(project.id, {
    one: { class_type: 'Example', inputs: { prompt: '', image: '' } },
  }, { prompt: { node: 'one', input: 'prompt' }, productImage: { node: 'one', input: 'image' } });
  return project;
}

async function verifyMissingAssets({ project, video, image }, { call, openProject, clickButton, evaluate, waitFor }) {
  const input = { script: '缺少原文件时保存剧本', referenceVideo: video.id, referenceImage: image.id };
  const saved = await call('saveInputs', project.id, input);
  assert.deepEqual(saved.inputs, input);
  await assert.rejects(call('saveInputs', project.id, { ...input, referenceVideo: 'unknown' }), /重新选择或定位/);
  await assert.rejects(call('saveInputs', project.id, { ...input, referenceVideo: image.id }), /素材类型不符合/);
  await assert.rejects(call('analyze', project.id), /重新选择或定位/);
  const [shot] = await call('approveShots', project.id, [{ title: '开场', prompt: 'Opening scene', duration: 1 }]);
  await assert.rejects(call('generate', project.id, [shot.id]), /有效的项目素材/);

  await openProject(project.name);
  await clickButton('分析与分镜');
  const recoverVideo = JSON.stringify('重新定位 ' + video.name);
  const recoverImage = JSON.stringify('重新定位 ' + image.name);
  await waitFor(() => evaluate(`[...document.querySelectorAll('fieldset[aria-label="分析输入"] button')]
    .some(button => button.getAttribute('aria-label') === ${recoverVideo})`));
  const selected = await evaluate(`[...document.querySelectorAll('fieldset[aria-label="分析输入"] select')]
    .map(select => [select.value, select.selectedOptions[0].textContent])`);
  assert.deepEqual(selected, [[video.id, video.name + '（缺失）'], [image.id, image.name + '（缺失）']]);
  await evaluate(`(() => {
    const script = document.querySelector('fieldset[aria-label="分析输入"] textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(script, '可继续编辑的剧本');
    script.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickButton('镜头生成');
  await waitFor(() => evaluate(`[...document.querySelectorAll('.page button')]
    .some(button => button.getAttribute('aria-label') === ${recoverImage})`));
  assert.deepEqual((await call('project', project.id)).production.inputs, { ...input, script: '可继续编辑的剧本' });
  await clickButton('多轨剪辑');
  await waitFor(() => evaluate(`[...document.querySelectorAll('.page button')]
    .filter(button => button.getAttribute('aria-label') === ${recoverVideo}).length === 1`));
  await clickButton('项目素材');
  await waitFor(() => evaluate("document.querySelector('.project-navigation .active')?.textContent === '项目素材'"));
  console.log('素材缺失时保留输入引用，分析、镜头生成及剪辑均可定位素材');
}

async function verifyGenerationQueue(project, source, { clickButton, openProject, call, waitFor, evaluate }) {
  const png = fs.readFileSync(source);
  const submitted = new Map();
  let uploads = 0;
  let releaseFirst = false;
  let failFirstEngine = false;
  const handle = async (request, response) => {
    const json = value => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    if (request.url === '/object_info') {
      if (failFirstEngine && request.socket.localPort === server.address().port) return json({ Other: { input: {} } });
      return json({ Example: { input: {} } });
    }
    if (request.url === '/upload/image' || request.url === '/prompt') {
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      if (request.url === '/upload/image') return json({ name: `upload-${++uploads}.png` });
      const { prompt, prompt_id } = JSON.parse(Buffer.concat(buffers));
      submitted.set(prompt_id, prompt.one.inputs);
      return json({ prompt_id });
    }
    if (request.url.startsWith('/history/')) {
      if (!releaseFirst) return json({});
      const id = request.url.split('/').at(-1);
      return json({ [id]: { status: { completed: true }, outputs: { one: { images: [{ filename: 'output.png' }] } } } });
    }
    if (request.url === '/queue') return json({ queue_pending: [], queue_running: [[0, [...submitted.keys()][0]]] });
    if (request.url.startsWith('/view?')) return response.end(png);
    response.writeHead(404).end();
  };
  const server = http.createServer(handle);
  const replacement = http.createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await call('saveComfy', 'http://127.0.0.1:' + server.address().port);
    await openProject(project.name);
    await clickButton('镜头生成');
    await clickButton('全选');
    await clickButton('生成所选镜头（2）');
    await waitFor(() => submitted.size === 1);
    await waitFor(() => evaluate('document.body.innerText.includes("等待提交 · 第 1 位")'));
    const queued = (await call('project', project.id)).jobs.find(job => job.localQueue);
    assert.deepEqual(queued.localQueue, { position: 1, paused: false });
    releaseFirst = true;
    const complete = await waitFor(async () => (await call('project', project.id)).jobs.filter(job => job.status === 'done').length === 2);
    assert.equal(complete, true);
    assert.equal(uploads, 1);
    assert.deepEqual([...submitted.values()], [
      { image: 'upload-1.png', prompt: 'Opening' }, { image: 'upload-1.png', prompt: 'Detail' },
    ]);

    failFirstEngine = true;
    const [shot] = (await call('project', project.id)).shots;
    const [failedId] = await call('generate', project.id, [shot.id]);
    const original = await waitFor(async () => {
      const item = (await call('project', project.id)).jobs.find(job => job.id === failedId);
      return item?.status === 'failed' && item;
    });
    assert.match(JSON.parse(original.detail).error, /实例缺少节点/);
    assert.equal(original.retryOnCurrentEngine, undefined);
    await new Promise(resolve => replacement.listen(0, '127.0.0.1', resolve));
    const nextEndpoint = 'http://127.0.0.1:' + replacement.address().port;
    await call('connectExternalComfy', nextEndpoint);
    await clickButton('使用当前引擎重试');
    await waitFor(async () => {
      const current = (await call('project', project.id)).jobs;
      return current.some(item => item.status === 'done' && JSON.parse(item.detail).url === nextEndpoint);
    });
    assert.deepEqual([...submitted.values()].at(-1), { image: 'upload-2.png', prompt: 'Opening' });
    console.log('切换到兼容的 ComfyUI 后，任务页使用原审核参数重试成功');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (replacement.listening) {
      replacement.closeAllConnections();
      await new Promise(resolve => replacement.close(resolve));
    }
  }
}

async function verifyLinkedTimeline(project, { clickButton, openProject, call, evaluate, waitFor }) {
  const start = await call('project', project.id);
  const [red, blue] = start.tracks.find(track => track.kind === 'video').clips;
  await openProject(project.name);
  await clickButton('多轨剪辑');
  await waitFor(() => evaluate(`(() => {
    const source = document.querySelector('[data-clip-id="${blue.id}"]');
    const target = document.querySelector('[data-clip-id="${red.id}"]');
    if (!source || !target) return false;
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer, clientX: source.getBoundingClientRect().left + 2 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, clientX: target.getBoundingClientRect().left + 2 }));
    return true;
  })()`));
  const ordered = await waitFor(async () => {
    const { tracks } = await call('project', project.id);
    return tracks.find(track => track.kind === 'video').clips[0].id === blue.id && tracks;
  });
  assert.deepEqual(ordered.find(track => track.kind === 'subtitle').clips.map(clip => [clip.text, clip.start]),
    [['blue dialogue', 0], ['red dialogue', 1]]);
  const targetTime = 7 / (start.production.exportSettings?.fps ?? 30);
  await waitFor(() => evaluate(`parseFloat(document.querySelector('[data-clip-id="${blue.id}"]')?.style.left) === 0`));
  await evaluate(`(() => {
    const clip = document.querySelector('[data-clip-id="${blue.id}"]');
    const lane = clip.closest('.timeline-lane');
    const unit = document.querySelector('[aria-label="预览播放位置"]').getBoundingClientRect().width / 12;
    const dataTransfer = new DataTransfer();
    const startX = Math.round(clip.getBoundingClientRect().left);
    const dropX = Math.round(lane.getBoundingClientRect().left + ${targetTime} * unit);
    clip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer, clientX: startX }));
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, clientX: dropX, shiftKey: true }));
  })()`);
  const dragged = await waitFor(async () => {
    const { tracks } = await call('project', project.id);
    const clip = tracks.flatMap(track => track.clips).find(item => item.id === blue.id);
    return clip.start > 0 && tracks;
  });
  assert.equal(dragged.flatMap(track => track.clips).find(item => item.id === blue.id).start, targetTime);
  assert.equal(dragged.flatMap(track => track.clips).find(item => item.linked_video_id === blue.id).start, targetTime);
  await clickButton('撤销');
  await waitFor(async () => (await call('project', project.id)).tracks.find(track => track.kind === 'video').clips[0].start === 0);
  await clickButton('生成合成预览');
  await waitFor(() => evaluate("document.querySelector('.panel.preview video')?.readyState >= 2"));
  await waitFor(() => evaluate(`(() => {
    const ruler = document.querySelector('[aria-label="预览播放位置"]');
    if (!ruler) return false;
    const bounds = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bounds.left + bounds.width * 1.5 / 12 }));
    return true;
  })()`));
  await waitFor(() => evaluate("Math.abs(document.querySelector('.panel.preview video')?.currentTime - 1.5) < 0.04"));
  await clickButton('导出 MP4');
  const exported = await waitFor(async () => (await call('project', project.id)).jobs.find(job =>
    job.kind === 'export' && ['done', 'failed'].includes(job.status)));
  assert.equal(exported.status, 'done', exported.detail);
  const pixel = (job, seconds) => execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error',
    '-ss', String(seconds), '-i', JSON.parse(job.detail).file, '-vf', 'format=rgb24,crop=1:1:iw/2:ih/2',
    '-frames:v', '1', '-f', 'rawvideo', '-']);
  const first = pixel(exported, 0.25), second = pixel(exported, 1.25);
  assert.ok(first[2] > 200 && first[0] < 30);
  assert.ok(second[0] > 200 && second[2] < 30);

  const [base, captions] = ordered;
  await clickButton('＋视频轨');
  const overlay = await waitFor(async () => (await call('project', project.id)).tracks.find(track =>
    track.kind === 'video' && track.id !== base.id));
  await call('addClip', overlay.id, { asset_id: blue.asset_id, start: 1, duration: 1 });
  await call('addClip', captions.id, { text: '独立字幕', start: 0, duration: 1 });

  async function renderPreview() {
    const { jobs } = await call('project', project.id);
    const previous = jobs.find(job => job.kind === 'preview')?.id;
    await clickButton('生成合成预览');
    const observe = async () => {
      const job = (await call('project', project.id)).jobs.find(item => item.kind === 'preview');
      return job?.id !== previous ? job : undefined;
    };
    const result = await waitFor(async () => {
      const job = await observe();
      return job && (job.storageIssue || ['done', 'failed', 'interrupted', 'cancelled'].includes(job.status)) && job;
    }, '新建合成预览未完成').catch(async error => {
      const alert = await evaluate("document.querySelector('[role=alert]')?.innerText ?? ''").catch(() => '');
      const job = await observe().catch(() => undefined);
      throw new Error([error.message, job ? JSON.stringify(job) : '未创建新的预览任务', alert].filter(Boolean).join('\n'), { cause: error });
    });
    assert.ok(!result.storageIssue, JSON.stringify(result.storageIssue));
    assert.equal(result.status, 'done', result.detail);
    await waitFor(() => evaluate(`document.querySelector('.panel.preview video')?.getAttribute('src') === "media://render/${result.id}"`));
    return result;
  }

  const cover = await renderPreview();
  assert.ok(pixel(cover, 1.25)[2] > 200);
  const clickTrack = (label, expectedConfirmation) => waitFor(() => evaluate(`(() => {
    const button = [...document.querySelectorAll('.track-header button')]
      .find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)} && !item.disabled);
    if (!button) return false;
    const confirm = window.confirm;
    const expected = ${JSON.stringify(expectedConfirmation ?? null)};
    try {
      if (expected) window.confirm = message => {
        if (!message.includes(expected)) throw new Error(message);
        return true;
      };
      button.click();
      return true;
    } finally {
      window.confirm = confirm;
    }
  })()`));

  await clickTrack('重命名轨道 ' + overlay.name);
  await waitFor(() => evaluate(`(() => {
    const input = document.querySelector('[aria-label="新轨道名称"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '覆盖视频');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`));
  await clickButton('保存名称');
  await waitFor(() => evaluate("Boolean(document.querySelector('[aria-label=\"下移轨道 覆盖视频\"]'))"));
  assert.equal(await evaluate("document.querySelector('.panel.preview video')?.getAttribute('src')"), 'media://render/' + cover.id);

  await clickTrack('下移轨道 覆盖视频');
  await waitFor(async () => (await call('project', project.id)).tracks[1].id === overlay.id);
  await clickTrack('下移轨道 覆盖视频');
  await waitFor(async () => (await call('project', project.id)).tracks[0].id === overlay.id);
  await waitFor(() => evaluate("!document.querySelector('.panel.preview video')"));
  const revealed = await renderPreview();
  assert.ok(pixel(revealed, 1.25)[0] > 200);
  await clickButton('导出 MP4');
  const reorderedExport = await waitFor(async () => {
    const job = (await call('project', project.id)).jobs.find(item => item.kind === 'export');
    return job?.id !== exported.id && ['done', 'failed'].includes(job?.status) && job;
  });
  assert.equal(reorderedExport.status, 'done', reorderedExport.detail);
  assert.ok(pixel(reorderedExport, 1.25)[0] > 200);

  await waitFor(() => evaluate(`(() => {
    const selected = document.querySelector('[data-clip-id="${red.id}"]');
    if (!selected) return false;
    selected.click();
    return true;
  })()`));
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-clip-id="${red.id}"].active'))`));
  await evaluate(`(() => {
    const ruler = document.querySelector('[aria-label="预览播放位置"]');
    const bounds = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: bounds.left + bounds.width * 1.5 / 12 }));
  })()`);
  await clickButton('在播放头拆分');
  async function baseClips(count) {
    return waitFor(async () => {
      const current = await call('project', project.id);
      return current.tracks.find(track => track.id === base.id)?.clips.length === count && current;
    });
  }
  const split = await baseClips(3);
  const halves = split.tracks.find(track => track.id === base.id).clips.slice(1);
  assert.deepEqual(halves.map(clip => [clip.start, clip.duration]), [[1, 0.5], [1.5, 0.5]]);
  assert.deepEqual(split.tracks.find(track => track.id === captions.id).clips
    .filter(clip => clip.text === 'red dialogue').map(clip => clip.linked_video_id), halves.map(clip => clip.id));
  await clickButton('撤销');
  await baseClips(2);
  await waitFor(() => evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '重做' && !button.disabled)"));
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))");
  assert.deepEqual((await baseClips(3)).tracks, split.tracks);
  await clickButton('撤销');
  await baseClips(2);

  await clickButton('red dialogue');
  await waitFor(() => evaluate(`(() => {
    const input = document.querySelector('.clip-editor textarea');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '即将删除的联动字幕');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`));
  await clickTrack('删除轨道 ' + base.name, '2 个关联字幕');
  const deleted = await waitFor(async () => {
    const current = await call('project', project.id);
    return current.tracks.length === 2 && current;
  });
  assert.deepEqual(deleted.tracks.map(track => track.name), ['覆盖视频', captions.name]);
  assert.deepEqual(deleted.tracks[1].clips.map(clip => clip.text), ['独立字幕']);
  assert.equal(deleted.assets.length, start.assets.length);
  assert.ok(deleted.assets.every(asset => asset.exists));
  assert.ok(fs.existsSync(JSON.parse(exported.detail).file));
  await clickButton('撤销');
  const restoredTrack = await baseClips(2);
  assert.ok(restoredTrack.tracks.find(track => track.id === captions.id).clips.some(clip => clip.linked_video_id === red.id));
  await clickButton('重做');
  await waitFor(async () => (await call('project', project.id)).tracks.length === 2);
  await waitFor(() => evaluate("!document.querySelector('.clip-editor') && !document.querySelector('.panel.preview video')"));
  const lastPreview = await renderPreview();
  assert.ok(pixel(lastPreview, 1.25)[2] > 200);
  console.log('播放头拆分、字幕关联、撤销删除轨道与重做已通过');

  // Simulate moving a published video away while its edit and job history remain.
  await clickButton('项目素材');
  await waitFor(() => evaluate("!document.querySelector('.panel.preview video')"));
  const oldFile = JSON.parse(exported.detail).file;
  fs.renameSync(oldFile, oldFile + '.moved');
  await assert.rejects(call('revealRender', exported.id), /成片文件不可用/);
  fs.unlinkSync(JSON.parse(lastPreview.detail).file);
  await clickButton('多轨剪辑');
  await waitFor(() => evaluate("document.body.innerText.includes('预览文件不可用')"), '缺失的预览应有重新生成提示');
  assert.ok(pixel(await renderPreview(), 1.25)[2] > 200);

  await clickButton('任务');
  await clickButton('重新导出');
  const restoredExport = await waitFor(async () => {
    const job = (await call('project', project.id)).jobs.find(item => item.kind === 'export');
    return job?.id !== reorderedExport.id && ['done', 'failed'].includes(job?.status) && job;
  });
  assert.equal(restoredExport.status, 'done', restoredExport.detail);
  const { format, resolution, fps, snapshot } = JSON.parse(restoredExport.detail);
  const original = JSON.parse(exported.detail);
  assert.deepEqual([format, resolution, fps, snapshot.tracks],
    [original.format, original.resolution, original.fps, original.snapshot.tracks]);
  assert.ok(fs.existsSync(oldFile + '.moved'));
  assert.ok(pixel(restoredExport, 0.25)[2] > 200);
  assert.ok(pixel(restoredExport, 1.25)[0] > 200);
  console.log('缺失的预览可重新生成，移动后的成片可按原时间线和参数重新导出');
}

async function verifyEnhancementReview(directory, executable) {
  const profile = path.join(directory, 'enhancement-review-profile');
  const ffmpeg = resolveFFmpeg();
  const sources = ['red', 'blue'].map(color => {
    const file = path.join(directory, `enhancement-${color}.mp4`);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=${color}:s=64x64:r=24:d=1`, '-c:v', 'libx264', file]);
    return file;
  });
  await store.init(profile);
  const project = store.createProject('增强结果版本验证', path.join(directory, 'review-enhancement'), templates[2]);
  const [asset] = await store.addMedia(project.id, [{ src: sources[0], kind: 'video', duration: 1, origin: 'comfy' }]);
  store.saveProduction(project.id, { approvedOutput: asset.id });
  const track = store.addTrack(project.id, 'video', '视频');
  const clip = store.addClip(track.id, { asset_id: asset.id, in_point: 0.25, duration: 0.5 });
  fs.unlinkSync(asset.path);
  await store.relinkAsset(asset.id, sources[1], await probe(sources[1]));
  const comparison = store.createProject('增强同步对比', path.join(directory, 'enhancement-comparison'), templates[2]);
  const originalFile = path.join(directory, 'comparison-original.mov');
  const resultFile = path.join(directory, 'comparison-result.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=3',
    '-c:v', 'prores', originalFile]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=128x128:r=24:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=490:sample_rate=48000:duration=2', '-c:v', 'libx264', '-c:a', 'aac', resultFile]);
  const [original] = await store.addMedia(comparison.id, [{ src: originalFile, ...await probe(originalFile) }]);
  const detail = { assetInputs: { sourceVideo: original.id }, assetRevisions: { sourceVideo: 0 } };
  const job = store.addJob(comparison.id, 'comfy', detail);
  const [result] = await store.addMedia(comparison.id, [{ src: resultFile, ...await probe(resultFile), origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...detail, assets: [result.id] }) });

  await desktopSession(executable || require('electron'), executable ? [] : ['.'], profile, async session => {
    const { call, openProject, waitFor, evaluate, quit } = session;
    const press = label => waitFor(() => evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`), '未找到操作 ' + label);
    await openProject(project.name);
    await press('多轨剪辑');
    await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.page button'))
      .some(item => item.textContent.trim() === '导出 MP4' && item.disabled)`));
    await assert.rejects(call('addClip', track.id, { asset_id: asset.id }), /确认增强结果/);
    for (const preview of [true, false]) {
      await assert.rejects(call('export', project.id, 'square', preview, 720, 24), /确认增强结果/);
    }
    await assert.rejects(call('reviewEnhance', project.id, asset.id, 0), /增强结果已更新/);
    await press('前往确认增强结果');
    await press('确认增强结果');
    await waitFor(async () => (await call('project', project.id)).assets[0].enhancementReviewRequired === false);
    const current = await call('project', project.id);
    assert.deepEqual(current.tracks[0].clips[0], clip);
    const jobId = await call('export', project.id, 'square', false, 720, 24);
    const finished = await waitFor(async () => (await call('project', project.id)).jobs
      .find(job => job.id === jobId && ['done', 'failed'].includes(job.status)));
    assert.equal(finished.status, 'done', finished.detail);
    const { file } = JSON.parse(finished.detail);
    const pixels = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', 'crop=2:2', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    assert.ok(pixels[2] > 240 && pixels[0] < 20, '应导出重新确认后的蓝色增强结果');

    const recorded = current.assets[0];
    const mediaStatus = (scope, method) => evaluate(`fetch(${JSON.stringify('media://' + scope + '/' + asset.id)},
      { method: ${JSON.stringify(method)}, headers: ${method === 'GET' ? '{Range:"bytes=0-31"}' : '{}'} })
      .then(async response => { await response.arrayBuffer(); return response.status; })`);
    assert.equal(await mediaStatus('asset', 'GET'), 206);
    await call('prepareAssetPreview', asset.id);
    assert.equal(await mediaStatus('proxy', 'GET'), 206);
    const previewId = await call('export', project.id, 'landscape', true);
    assert.equal((await waitFor(async () => (await call('project', project.id)).jobs
      .find(job => job.id === previewId && ['done', 'failed'].includes(job.status)))).status, 'done');
    await press('多轨剪辑');
    await waitFor(() => evaluate(`document.querySelector('.panel.preview video')?.getAttribute('src')
      === ${JSON.stringify('media://render/' + previewId)}`));

    // Keep the registered path and review but overwrite the actual bytes.
    fs.copyFileSync(sources[0], recorded.path);
    await evaluate('window.dispatchEvent(new Event("focus")); true');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[aria-label="已变更或无法读取的时间线素材"]'))
      && !document.querySelector('.panel.preview video')`));
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.page button'))
      .some(button => button.textContent.trim() === '导出 MP4' && button.disabled)`));
    assert.equal(await mediaStatus('asset', 'HEAD'), 409);
    assert.equal(await mediaStatus('asset', 'GET'), 409);
    assert.equal(await mediaStatus('proxy', 'GET'), 409);
    await assert.rejects(call('prepareAssetPreview', asset.id), /素材内容已变更/);
    await assert.rejects(call('reviewEnhance', project.id, asset.id, recorded.revision), /素材内容已变更/);
    await assert.rejects(call('addClip', track.id, { asset_id: asset.id }), /素材内容已变更/);
    await press('画质增强');
    await press('对比预览');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.panel.preview [role="alert"]')?.textContent.includes('素材内容已变更'))
      && Array.from(document.querySelectorAll('.panel.preview button')).some(button => button.textContent === '重新定位或替换')
      && !document.querySelector('.panel.preview video')`));
    assert.ok(await evaluate(`!Array.from(document.querySelectorAll('.page button')).some(button => button.textContent === '加入时间线')`));

    fs.copyFileSync(sources[1], recorded.path);
    await press('重试预览');
    await waitFor(() => evaluate("document.querySelector('.panel.preview video')?.readyState >= 2"));
    assert.equal(await mediaStatus('asset', 'HEAD'), 200);
    await press('多轨剪辑');
    await waitFor(() => evaluate(`document.querySelector('.panel.preview video')?.getAttribute('src')
      === ${JSON.stringify('media://render/' + previewId)}`));
    await openProject(comparison.name);
    await press('画质增强');
    await press('对比预览');
    const getPlayers = `Array.from(document.querySelectorAll('.panel.preview video'))`;
    const readPlayers = () => evaluate(`${getPlayers}.map(player => ({
      time: player.currentTime, duration: player.duration, paused: player.paused, seeking: player.seeking, muted: player.muted,
      controls: player.controls,
    }))`);
    const scrub = time => evaluate(`(() => {
      const slider = document.querySelector('[aria-label="对比播放位置"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, ${JSON.stringify(String(time))});
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const synchronized = async (time, paused) => {
      const players = await readPlayers();
      return players.length === 2 && players.every(player => player.paused === paused && !player.seeking &&
        (time === undefined || Math.abs(player.time - time) <= 0.001)) &&
        Math.abs(players[0].time - players[1].time) < (paused ? 0.002 : 0.08) && players;
    };
    const limit = await waitFor(() => evaluate(`Number(document.querySelector('[aria-label="对比播放位置"]')?.max) || false`));
    const initial = await waitFor(() => synchronized(0, true));
    assert.equal(limit, Math.min(...initial.map(player => player.duration)));
    assert.ok(Math.abs(limit - 2) < 0.025);
    assert.deepEqual(initial.map(player => [player.muted, player.controls]), [[true, false], [false, false]]);
    await scrub(0.625);
    await waitFor(() => synchronized(0.625, true));
    await press('同时播放');
    await waitFor(async () => (await synchronized(undefined, false))?.[1].time > 0.7);
    await press('同时暂停');
    await waitFor(() => synchronized(undefined, true));
    await scrub(1.75);
    await waitFor(() => synchronized(1.75, true));
    await press('同时播放');
    await waitFor(() => synchronized(limit, true));
    await press('同时播放');
    await waitFor(async () => {
      const players = await synchronized(undefined, false);
      return players && players[1].time < 0.8;
    });
    await evaluate(`${getPlayers}[0].pause()`);
    await waitFor(() => synchronized(undefined, true));
    await quit();
  });
  await store.init(profile);
  const restored = store.project(project.id);
  assert.equal(restored.assets[0].enhancementReviewRequired, false);
  assert.deepEqual(restored.tracks[0].clips[0], clip);
  console.log('增强结果重新定位后保留剪辑点，旧审核被拒绝，确认当前版本后导出并恢复通过');
  console.log('同路径覆盖素材会暂停素材预览、合成预览和审核，恢复原文件后可以继续预览');
  console.log('增强对比的共用进度、播放暂停、短片结尾及兼容代理已通过');
}

async function smoke(directory, executable) {
  const profile = path.join(directory, 'profile');
  const source = path.join(directory, 'prores.mov');
  execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=red:s=64x64:d=1', '-c:v', 'prores', source]);
  await store.init(profile);
  const fixtures = store.createProject('Compatibility test', path.join(directory, 'compatibility'), {
    ...templates[0], version: 2, fields: ['script'], description: '早期文字剧本模板，仅使用文字素材。',
    analysisPrompt: '按早期模板规则分析剧本。' + templates[0].analysisPrompt,
  });
  const manual = store.createProject('Manual storyboard', path.join(directory, 'manual'), {
    ...templates[0], version: 2, stages: ['input', 'review', 'generate', 'edit', 'export'],
  });
  const [fixture] = await store.addMedia(fixtures.id, [{ src: source, kind: 'video', duration: 1 }]);
  const linkedTimeline = await createLinkedTimeline(directory);
  const queuedGeneration = await createQueuedGeneration(directory);
  const hdrProject = store.createProject('HDR preview', path.join(directory, 'hdr preview'), templates[0]);
  const hdrSource = path.join(directory, 'hdr-source.mp4');
  execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=gray:s=96x54:r=24:d=1,format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'log-level=error', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', hdrSource]);
  const [hdrAsset] = await store.addMedia(hdrProject.id, [{ src: hdrSource, ...await probe(hdrSource) }]);
  store.addClip(store.addTrack(hdrProject.id, 'video', 'HDR').id, { asset_id: hdrAsset.id });
  const { dir, assets, tracks } = store.project(hdrProject.id);
  const hdrSettings = { format: 'landscape', resolution: 720, fps: 24 };
  store.saveProduction(hdrProject.id, { exportSettings: hdrSettings });
  // Seed the output and snapshot shape produced before color conversions were versioned.
  const oldPreview = store.addJob(hdrProject.id, 'preview', {
    ...hdrSettings, file: hdrSource, snapshot: { dir, assets, tracks },
    frameTimingVersion: 1, captionLayoutVersion: 1, videoTrimVersion: 1,
  });
  store.updateJob(oldPreview.id, { status: 'done' });
  const missingProject = store.createProject('Missing sources', path.join(directory, 'missing sources'), templates[0]);
  const [video, image] = await store.addMedia(missingProject.id, [
    { src: source, kind: 'video', duration: 1 }, { src: path.join(directory, 'red.png'), kind: 'image' },
  ]);
  store.saveInputs(missingProject.id, 'drama', { script: '初稿', referenceVideo: video.id, referenceImage: image.id });
  const referenceWorkflow = preset('drama', 'reference-video');
  store.saveWorkflow(missingProject.id, referenceWorkflow.workflow, referenceWorkflow.mapping);
  const missingTrack = store.addTrack(missingProject.id, 'video', '视频');
  for (let index = 0; index < 2; index++) store.addClip(missingTrack.id, { asset_id: video.id, duration: 0.5 });
  for (const asset of [video, image]) fs.unlinkSync(asset.path);
  const fashion = store.createProject('Text-only fashion', path.join(directory, 'text-only fashion'), templates[1]);
  const [missingProduct] = await store.addMedia(fashion.id, [{ src: path.join(directory, 'red.png'), kind: 'image' }]);
  store.saveInputs(fashion.id, 'fashion', { product: '蓝色外套', sellingPoints: '防风', productImage: missingProduct.id });
  fs.unlinkSync(missingProduct.path);
  const appArgs = executable ? [] : ['.'];
  await desktopSession(executable || require('electron'), appArgs, profile, async session => {
    const { evaluate, call, devToolsCall, waitFor, openProject, quit } = session;
    const project = await evaluate(`window.api.call('createProject','Smoke test',${JSON.stringify(path.join(directory, 'project'))},'drama')`);
    assert.equal(project.ok, true, JSON.stringify(project));
    await verifyTextOnlyFashion(fashion, missingProduct, session);
    await verifyAnalysisRevision(fixtures, session);
    await devToolsCall('Page.reload', { ignoreCache: true });
    async function clickButton(label) {
      await waitFor(() => evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.trim() === ${JSON.stringify(label)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`).catch(() => false), '未找到桌面操作 ' + label);
    }
    await openProject(manual.name);
    await clickButton('分镜审核');
    await waitFor(() => evaluate(`document.querySelector('.page h1')?.textContent === '分镜审核'`));
    const availableActions = await evaluate(`[...document.querySelectorAll('.page button')].map(button => button.textContent.trim())`);
    assert.ok(availableActions.includes('确认当前分镜'));
    assert.equal(availableActions.includes('AI 分析'), false);
    await assert.rejects(call('analyze', manual.id), /不包含 AI 分析阶段/);
    await clickButton('项目首页');
    await verifyEngineSetup({ clickButton, call, waitFor, evaluate, openProject }, fixtures);
    await verifyMissingAssets({ project: missingProject, video, image }, { clickButton, openProject, call, waitFor, evaluate });
    await verifyGenerationQueue(queuedGeneration, path.join(directory, 'red.png'), { clickButton, openProject, call, waitFor, evaluate });
    await verifyLinkedTimeline(linkedTimeline, { clickButton, openProject, call, waitFor, evaluate });
    await openProject('Smoke test');
    await clickButton('分析与分镜');
    await clickButton('添加镜头');
    await waitFor(() => evaluate(`(() => {
      const textarea = document.querySelector('textarea[placeholder]');
      if (!document.body?.innerText.includes('新镜头') && !document.querySelector('input[value="新镜头"]')) return false;
      const script = textarea || document.querySelector('textarea');
      if (!script) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(script, '保留的剧本');
      script.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await clickButton('项目首页');
    await waitFor(() => evaluate("document.body?.innerText.includes('创建视频项目')"));
    const saved = await evaluate(`window.api.call('project',${JSON.stringify(project.data.id)}).then(result => result.data.production)`);
    assert.equal(saved.inputs.script, '保留的剧本');
    assert.equal(saved.draftShots[0].title, '新镜头');
    const renderId = await evaluate(`(async () => {
      async function call(...args) { const result = await window.api.call(...args); if (!result.ok) throw Error(result.error); return result.data; }
      const projectId = ${JSON.stringify(project.data.id)};
      const track = await call('addTrack', projectId, 'subtitle', 'Captions');
      await call('addClip', track.id, { text:'桌面测试 100%', duration:1 });
      return call('export', projectId, 'landscape', true);
    })()`);
    const job = await waitFor(() => evaluate(`window.api.call('project',${JSON.stringify(project.data.id)}).then(result =>
      result.data?.jobs.find(item => item.id === ${JSON.stringify(renderId)} && ['done', 'failed'].includes(item.status)))`));
    assert.equal(job.status, 'done', job.detail);
    const media = await evaluate(`fetch('media://render/${renderId}',{headers:{Range:'bytes=0-31'}}).then(async response =>
      ({status:response.status,type:response.headers.get('content-type'),size:(await response.arrayBuffer()).byteLength}))`);
    assert.deepEqual(media, { status: 206, type: 'video/mp4', size: 32 });
    await openProject('Compatibility test');
    await clickButton('预览');
    await waitFor(() => evaluate(`(() => {
      const player = document.querySelector('video');
      return player?.readyState >= 2 && player.videoWidth === 64;
    })()`));
    const compatible = await evaluate(`window.api.call('prepareAssetPreview', ${JSON.stringify(fixture.id)})`);
    assert.deepEqual(compatible, { ok: true, data: 'media://proxy/' + fixture.id });

    await openProject(hdrProject.name);
    await clickButton('预览');
    await waitFor(() => evaluate(`(() => {
      const player = document.querySelector('video');
      return player?.readyState >= 2 && player.getAttribute('src') === ${JSON.stringify('media://proxy/' + hdrAsset.id)};
    })()`), 'HDR 素材未自动切到 SDR 代理');
    await clickButton('多轨剪辑');
    await waitFor(() => evaluate("document.body.innerText.includes('当前预览需要重新生成。') && !document.querySelector('video')"),
      '升级后仍显示旧 HDR 合成预览');
    await clickButton('生成合成预览');
    const hdrPreview = await waitFor(() => evaluate("document.querySelector('video')?.getAttribute('src')"));
    assert.notEqual(hdrPreview, 'media://render/' + oldPreview.id);
    const hdrJobs = (await call('project', hdrProject.id)).jobs;
    assert.equal(JSON.parse(hdrJobs.find(job => job.id === hdrPreview.split('/').at(-1)).detail).colorPipelineVersion, 1);
    console.log('HDR 素材自动使用 SDR 代理，升级后可重建并播放合成预览');

    await openProject('Smoke test');
    await clickButton('多轨剪辑');
    await waitFor(() => evaluate(`(() => {
      const format = [...document.querySelectorAll('select')].find(element => element.querySelector('[value="square"]'));
      if (!format) return false;
      format.value = 'square';
      format.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    await clickButton('生成合成预览');
    const previousPreview = await waitFor(() => evaluate("document.querySelector('video')?.getAttribute('src')"));
    await waitFor(() => evaluate(`(() => {
      const fps = [...document.querySelectorAll('select')].find(element => element.querySelector('[value="24"]'));
      if (!fps) return false;
      fps.value = '24';
      fps.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    await waitFor(() => evaluate("/当前预览需要重新生成|帧率已修改/.test(document.body.innerText) && !document.querySelector('video')"));
    await clickButton('生成合成预览');
    const preview = await waitFor(() => evaluate("document.querySelector('video')?.getAttribute('src')"));
    assert.notEqual(preview, previousPreview);
    const current = await call('project', project.data.id);
    const previewJob = current.jobs.find(item => item.id === preview.split('/').at(-1));
    assert.equal((await probe(JSON.parse(previewJob.detail).file)).fps, 24);
    await clickButton('项目素材');
    await clickButton('多轨剪辑');
    await waitFor(() => evaluate(`document.querySelector('video')?.getAttribute('src') === ${JSON.stringify(preview)}`));
    assert.equal(await evaluate(`[...document.querySelectorAll('select')].find(element => element.querySelector('[value="square"]'))?.value`), 'square');
    await clickButton('桌面测试 100%');
    await waitFor(() => evaluate(`(() => {
      const input = document.querySelector('.clip-editor textarea');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '离开时间线前修改的字幕');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await clickButton('分析与分镜');
    assert.equal((await call('project', project.data.id)).tracks[0].clips[0].text, '离开时间线前修改的字幕');
    await clickButton('添加镜头');
    await waitFor(() => evaluate(`(() => {
      const script = document.querySelector('textarea');
      if (!script || document.querySelectorAll('.shot').length !== 2) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(script, '关闭应用前编辑的剧本');
      script.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await clickButton('项目管理');
    await waitFor(() => evaluate("document.querySelector('.project-manager') !== null"));
    assert.equal((await call('project', project.data.id)).production.inputs.script, '关闭应用前编辑的剧本');
    async function manageProject(name, label) {
      await waitFor(() => evaluate(`(() => {
        const row = [...document.querySelectorAll('.project-entry')].find(item => item.querySelector('h3').textContent === ${JSON.stringify(name)});
        const action = [...row?.querySelectorAll('button') ?? []].find(item => item.textContent === ${JSON.stringify(label)});
        if (!action || action.disabled) return false;
        action.click();
        return true;
      })()`));
    }
    await manageProject('Smoke test', '重命名');
    const newName = '归档验收项目';
    await waitFor(() => evaluate(`(() => {
      const input = document.querySelector('[aria-label="新项目名称"]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(newName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
    await clickButton('保存名称');
    await manageProject(newName, '归档');
    await waitFor(() => evaluate(`(![...document.querySelectorAll('aside button')].some(item => item.textContent === ${JSON.stringify(newName)}) &&
      document.body.innerText.includes('项目已归档'))`));
    assert.ok(!(await call('projects')).some(item => item.id === project.data.id));
    assert.ok((await call('projects', true)).find(item => item.id === project.data.id)?.archived_at);
    await assert.rejects(call('project', project.data.id), /项目已归档/);
    await manageProject(newName, '恢复到项目列表');
    await openProject(newName);
    const reopened = await call('project', project.data.id);
    assert.equal(reopened.name, newName);
    assert.equal(reopened.archived_at, null);
    assert.equal(reopened.tracks[0].clips[0].text, '离开时间线前修改的字幕');
    await quit();
    await store.init(profile);
    const restoredTracks = store.project(linkedTimeline.id).tracks;
    assert.deepEqual(restoredTracks.map(track => track.name), ['覆盖视频', '台词字幕']);
    assert.deepEqual(restoredTracks[1].clips.map(clip => clip.text), ['独立字幕']);
    assert.equal(store.timelineHistory(linkedTimeline.id, restoredTracks).undo, '删除轨道');
    const currentProject = store.project(project.data.id);
    assert.equal(currentProject.name, newName);
    const restored = currentProject.production;
    assert.equal(restored.inputs.script, '关闭应用前编辑的剧本');
    assert.equal(restored.draftShots.length, 2);
    assert.equal(restored.exportSettings.format, 'square');
    assert.equal(restored.exportSettings.fps, 24);
  console.log('Electron 引擎配置、密钥隔离、分析版本、生成队列、素材复用、时间线和 MP4 通过');
  });
}

async function verifyReferenceRevision(directory, executable) {
  const profile = path.join(directory, 'reference revision profile');
  const source = path.join(directory, 'reference with audio.mp4');
  execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', source]);
  await store.init(profile);
  const media = await probe(source);
  const line = '带上蓝色票根，渡船三点出发。';
  const original = { summary: '码头见面', characters: ['乘客'], scenes: [], sceneCuts: [{ start: 0, end: 1 }] };
  const projects = [];
  for (const name of ['参考视频修订', '旧版参考视频修订']) {
    const project = store.createProject(name, path.join(directory, name), templates[0]);
    const [reference] = await store.addMedia(project.id, [{ src: source, ...media }]);
    const state = store.saveInputs(project.id, 'drama', { referenceVideo: reference.id });
    projects.push({ ...project, reference });
    if (projects.length === 2) store.saveProduction(project.id, {
      analysis: { ...original, referenceSources: { script: false, frames: 0, transcription: 'used' } },
      analysisInputRevision: state.inputRevision,
    });
  }
  const [fresh, legacy] = projects;
  const long = store.createProject('分段转写恢复', path.join(directory, 'long reference project'), templates[0]);
  const longVideo = path.join(directory, 'long reference.mp4');
  execFileSync(resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=1:d=1',
    '-f', 'lavfi', '-i', 'sine=440:sample_rate=8000:d=1081', '-c:v', 'libx264', '-c:a', 'aac', longVideo]);
  const [longAsset] = await store.addMedia(long.id, [{ src: longVideo, ...await probe(longVideo) }]);
  store.saveInputs(long.id, 'drama', { referenceVideo: longAsset.id });
  const longLines = ['带上蓝色票根。', '记得关上闸门。', '最后一班船到港。'];
  const longUploads = [];
  const correctedSummary = '用户补充了夜航场次。';
  let missingSegment = true;
  let analysisOutage = true;
  let transcriptions = 0;
  const revisions = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/long/v1/audio/transcriptions') {
        const segment = Number(/filename="audio-(\d+)\.mp3"/.exec(body)?.[1]);
        assert.ok(segment >= 0 && segment < longLines.length);
        longUploads.push(segment);
        if (missingSegment && segment === 1) response.writeHead(503).end('{}');
        else response.end(JSON.stringify({ text: longLines[segment] }));
        return;
      }
      if (request.url === '/long/v1/chat/completions') {
        const { messages } = JSON.parse(body);
        const review = messages[1].content.startsWith('{"analysis":');
        if (review && analysisOutage) {
          response.writeHead(503).end('{}');
          return;
        }
        if (review) {
          const { analysis } = JSON.parse(messages[1].content);
          assert.equal(analysis.summary, correctedSummary);
          assert.equal(analysis.referenceTranscript, longLines.join('\n'));
        } else assert.ok(messages[1].content.includes('缺少第 2 段'));
        const result = { ...original, shots: [{ title: '夜航', prompt: 'A ferry docks at sunset', duration: 1,
          dialogue: review ? longLines[1] : longLines[0] }] };
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
        return;
      }
      if (request.url === '/v1/audio/transcriptions') {
        assert.match(body, /filename="audio-000.mp3"/);
        transcriptions++;
        response.end(JSON.stringify({ text: line }));
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      const { messages } = JSON.parse(body);
      if (messages[1].content.includes('检测到的镜头时间范围')) assert.ok(messages[1].content.includes(line));
      else {
        const { analysis } = JSON.parse(messages[1].content);
        assert.equal(analysis.referenceTranscript, line);
        assert.deepEqual(analysis.sceneCuts, original.sceneCuts);
        revisions.push(analysis.summary);
      }
      const shots = [{ title: '渡船出发', prompt: 'A ferry leaves the dock', duration: 1, dialogue: line }];
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...original, shots }) } }] }));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const app = executable || require('electron');
  const args = executable ? [] : ['.'];
  const click = (session, label) => session.waitFor(() => session.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`), '未找到操作 ' + label);
  const openAnalysis = async (session, project) => {
    await session.openProject(project.name);
    await click(session, '分析与分镜');
  };
  const revise = async (session, project, count) => {
    await click(session, '从修订后的分析生成分镜建议');
    await session.waitFor(() => revisions.length === count);
    await session.waitFor(() => session.evaluate("document.body.innerText.includes('已根据修改后的分析生成分镜建议。')"));
    const { production } = await session.call('project', project.id);
    assert.equal(production.analysis.referenceTranscript, line);
    assert.equal(production.analysisShots[0].dialogue, line);
  };
  try {
    const configuration = (prefix = '') => ({
      url: 'http://127.0.0.1:' + server.address().port + prefix + '/v1', model: 'fixture', apiKey: 'reference-smoke-key',
    });
    await desktopSession(app, args, profile, async session => {
      await session.call('saveAI', configuration());
      await openAnalysis(session, fresh);
      await click(session, 'AI 分析');
      await session.waitFor(() => session.evaluate(`document.querySelector('textarea[aria-label="参考视频转写"]')?.value === ${JSON.stringify(line)}`));
      await session.evaluate(`(() => {
        const field = document.querySelector('fieldset[aria-label="编辑分析结果"] textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '用户修订的渡船场次');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await revise(session, fresh, 1);
      assert.deepEqual(revisions, ['用户修订的渡船场次']);
      assert.equal(transcriptions, 1);

      await session.call('saveAI', configuration('/long'));
      await openAnalysis(session, long);
      await click(session, 'AI 分析');
      await session.waitFor(() => session.evaluate("document.body.innerText.includes('缺少第 2 段')"));
      const { production } = await session.call('project', long.id);
      assert.equal(production.analysis.referenceTranscript, [longLines[0], longLines[2]].join('\n'));
      assert.deepEqual(longUploads, [0, 1, 2]);
      await session.evaluate(`(() => {
        const field = document.querySelector('fieldset[aria-label="编辑分析结果"] textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(correctedSummary)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      missingSegment = false;
      await click(session, '补转写并更新分镜建议');
      await session.waitFor(() => session.evaluate("document.querySelector('[role=alert]')?.textContent.includes('HTTP 503')"));
      assert.deepEqual(longUploads, [0, 1, 2, 1]);
      await session.quit();
    });
    fs.unlinkSync(fresh.reference.path);
    await desktopSession(app, args, profile, async session => {
      analysisOutage = false;
      await openAnalysis(session, long);
      await click(session, '补转写并更新分镜建议');
      await session.waitFor(() => session.evaluate("document.body.innerText.includes('已更新转写和分镜建议。')"));
      const { production } = await session.call('project', long.id);
      assert.deepEqual(longUploads, [0, 1, 2, 1]);
      assert.equal(production.analysis.summary, correctedSummary);
      assert.equal(production.analysis.referenceSources.transcription, 'used');
      assert.equal(production.analysis.referenceTranscript, longLines.join('\n'));
      assert.equal(production.analysisShots[0].dialogue, longLines[1]);

      await session.call('saveAI', configuration());
      await openAnalysis(session, fresh);
      await revise(session, fresh, 2);
      assert.equal(transcriptions, 1);
      await openAnalysis(session, legacy);
      await revise(session, legacy, 3);
      assert.equal(transcriptions, 2);
      await revise(session, legacy, 4);
      assert.equal(transcriptions, 2);
      await session.quit();
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('参考视频分镜修订保留转写与镜头时间，重启后复用已存转写，旧版项目可从原视频补回转写');
  console.log('三段音轨只补传失败分段。分镜服务断开后，重启可复用完整转写，并保留已修订摘要。');
}

async function verifyDraftRecovery(directory, executable) {
  const profile = path.join(directory, 'forced quit profile');
  const name = '强制退出验收';
  const updatedScript = '尚未提交的新版剧本';
  const updatedSummary = '恢复的分析摘要';
  const updatedCaption = '恢复后继续修改的字幕';
  const unfinishedWorkflow = '{"missingClosingBrace":';
  await store.init(profile);
  const project = store.createProject(name, path.join(directory, name), templates[0]);
  store.saveInputs(project.id, 'drama', { script: '已保存的原剧本' });
  store.saveProduction(project.id, { analysis: { summary: '已保存分析', characters: [], scenes: [], sceneCuts: [] } });
  const [shot] = store.setShots(project.id, [{ prompt: 'A clock face', duration: 1 }], true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  store.setSetting('comfy', { mode: 'external', url: 'http://127.0.0.1:1' });
  const track = store.addTrack(project.id, 'subtitle', '字幕');
  const clip = store.addClip(track.id, { text: '已保存字幕', duration: 1 });
  const app = executable || require('electron');
  const args = executable ? [] : ['.'];

  function click({ evaluate, waitFor }, label) {
    return waitFor(() => evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.matches(':disabled')) return false;
      button.click();
      return true;
    })()`));
  }
  function setField({ evaluate, waitFor }, selector, value) {
    return waitFor(() => evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      if (!field) return false;
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`));
  }

  await desktopSession(app, args, profile, async session => {
    await session.openProject(name);
    await click(session, '分析与分镜');
    await setField(session, 'textarea[rows="7"]', updatedScript);
    await setField(session, 'fieldset[aria-label="编辑分析结果"] textarea', updatedSummary);
    await setField(session, '.shot input[type="number"]', '0');
    const before = await session.waitFor(async () => {
      const value = await session.call('project', project.id);
      return value.editorDrafts.inputs?.script === updatedScript &&
        value.editorDrafts.analysis?.summary === updatedSummary && value.editorDrafts.shots?.[0]?.duration === 0 && value;
    });
    assert.equal(before.production.inputs.script, '已保存的原剧本');
    assert.equal(before.production.analysis.summary, '已保存分析');
    assert.equal(before.shots[0].duration, 1);
    await session.forceQuit();
  });

  await desktopSession(app, args, profile, async session => {
    await session.openProject(name);
    assert.equal(await session.evaluate('document.querySelector(\'textarea[rows="7"]\')?.value'), updatedScript);
    assert.equal(await session.evaluate('document.querySelector(\'fieldset[aria-label="编辑分析结果"] textarea\')?.value'), updatedSummary);
    assert.equal(await session.evaluate('document.querySelector(\'.shot input[type="number"]\')?.value'), '0');
    await assert.rejects(session.call('generate', project.id, [shot.id]), /请确认或放弃分镜草稿/);
    await assert.rejects(session.call('appendStoryboard', project.id), /确认当前分镜/);
    assert.equal((await session.call('project', project.id)).jobs.length, 0);
    await setField(session, '.shot input[type="number"]', '-1');
    await session.quit();
  });

  await desktopSession(app, args, profile, async session => {
    await session.openProject(name);
    assert.equal(await session.evaluate('document.querySelector(\'.shot input[type="number"]\')?.value'), '-1');
    const recovered = await session.call('project', project.id);
    assert.equal(recovered.shots[0].duration, 1);
    assert.equal(recovered.production.inputs.script, updatedScript);
    assert.equal(recovered.production.analysis.summary, updatedSummary);
    await setField(session, '.shot input[type="number"]', '2');
    await click(session, '确认当前分镜');
    await session.waitFor(async () => {
      const value = await session.call('project', project.id);
      return value.shots[0].duration === 2 && !value.editorDrafts.shots;
    });
    await click(session, '多轨剪辑');
    await click(session, '已保存字幕');
    await setField(session, '.clip-editor textarea', updatedCaption);
    const before = await session.waitFor(async () => {
      const value = await session.call('project', project.id);
      return value.editorDrafts.clip?.text === updatedCaption && value;
    });
    assert.equal(before.editorDrafts.clip.id, clip.id);
    assert.equal(before.tracks[0].clips[0].text, '已保存字幕');
    assert.equal(before.production.analysis.summary, updatedSummary);
    await session.forceQuit();
  });

  await desktopSession(app, args, profile, async session => {
    await session.openProject(name);
    assert.equal(await session.evaluate("document.querySelector('.clip-editor textarea')?.value"), updatedCaption);
    await setField(session, '.clip-editor .grid label:nth-child(2) input', '0');
    await click(session, '项目首页');
    await session.waitFor(() => session.evaluate('document.body.innerText.includes("创建视频项目")'), '离开项目时未保留未完成的片段草稿');
    await session.openProject(name);
    assert.equal(await session.evaluate("document.querySelector('.clip-editor .grid label:nth-child(2) input')?.value"), '0');
    assert.equal(await session.evaluate("document.querySelector('.clip-editor textarea')?.value"), updatedCaption);
    assert.equal((await session.call('project', project.id)).tracks[0].clips[0].duration, 1);
    await click(session, '放弃修改');
    await session.waitFor(() => session.evaluate("document.querySelector('.clip-editor textarea')?.value === '已保存字幕'"));
    await click(session, '镜头生成');
    await setField(session, 'textarea.code-field', unfinishedWorkflow);
    await session.waitFor(async () => (await session.call('project', project.id)).editorDrafts.workflow?.workflow === unfinishedWorkflow);
    await session.forceQuit();
  });

  await desktopSession(app, args, profile, async session => {
    await session.openProject(name);
    assert.equal(await session.evaluate("document.querySelector('textarea.code-field')?.value"), unfinishedWorkflow);
    await click(session, '项目素材');
    await session.waitFor(async () => {
      const value = await session.call('project', project.id);
      return value.production.workflowDraft?.workflow === unfinishedWorkflow && Object.keys(value.editorDrafts).length === 0;
    });
    await session.quit();
  });
  console.log('强制终止、正常退出和离开项目后可恢复草稿，生成和粗剪会等待分镜草稿确认');
}

async function verifyUpgrade(directory, previous, current, installUpgrade) {
  const profile = path.join(directory, '配置目录 profile');
  const script = 'Mina winds the clock.';
  const before = await desktopSession(previous, [], profile, async ({ call, waitFor, quit }) => {
    const project = await call('createProject', '升级验收', path.join(directory, '项目目录 project'), 'drama');
    await call('saveInputs', project.id, { script });
    await call('approveShots', project.id, [{ id: 'approved', title: '开场', prompt: script, duration: 1 }]);
    await call('saveDraft', project.id, [{ id: 'draft', title: '待审核', prompt: 'The clock face', duration: 1 }]);
    const track = await call('addTrack', project.id, 'subtitle', '字幕');
    await call('addClip', track.id, { text: '升级保留字幕', duration: 1 });
    const previewId = await call('export', project.id, 'portrait', true);
    const preview = await waitFor(async () => (await call('project', project.id)).jobs.find(job =>
      job.id === previewId && ['done', 'failed'].includes(job.status)));
    assert.equal(preview.status, 'done', preview.detail);
    await quit();
    return { ...project, previewId };
  });
  if (installUpgrade) installUpgrade();
  await desktopSession(current, [], profile, async ({ call, evaluate, waitFor, quit }) => {
    const restored = await call('project', before.id);
    assert.equal(restored.template_version, before.template_version);
    assert.equal(restored.production.inputs.script, script);
    assert.equal(restored.production.draftShots[0].id, 'draft');
    assert.deepEqual(restored.shots.map(shot => [shot.id, shot.status]), [['approved', 'approved']]);
    assert.equal(restored.tracks[0].clips[0].text, '升级保留字幕');
    for (const label of [before.name, '多轨剪辑']) {
      await waitFor(() => evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return false;
        button.click();
        return true;
      })()`));
    }
    let previewId = before.previewId;
    const originalPreview = restored.jobs.find(job => job.id === previewId);
    assert.equal(originalPreview?.status, 'done');
    if (!JSON.parse(originalPreview.detail).captionLayoutVersion) {
      await waitFor(() => evaluate('document.body.innerText.includes("当前预览需要重新生成。")'));
      await waitFor(() => evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '生成合成预览' && !item.disabled);
        return button && (button.click(), true);
      })()`));
      const regenerated = await waitFor(async () => (await call('project', before.id)).jobs.find(job =>
        job.kind === 'preview' && job.id !== before.previewId && ['done', 'failed'].includes(job.status)));
      assert.equal(regenerated.status, 'done', regenerated.detail);
      assert.equal(JSON.parse(regenerated.detail).captionLayoutVersion, 1);
      previewId = regenerated.id;
    }
    await waitFor(() => evaluate(`document.querySelector('video')?.getAttribute('src') === ${JSON.stringify('media://render/' + previewId)}`));
    const jobId = await call('export', before.id, 'portrait', false, 720);
    const job = await waitFor(async () => (await call('project', before.id)).jobs
      .find(item => item.id === jobId && ['done', 'failed'].includes(item.status)));
    assert.equal(job.status, 'done', job.detail);
    const video = await probe(JSON.parse(job.detail).file);
    assert.deepEqual([video.width, video.height, video.audio, video.fps], [720, 1280, true, 30]);
    await quit();
  });
  console.log('两版桌面程序共用同一配置目录，项目、草稿、已审核分镜、时间线、预览和正式导出验证通过');
}

async function verifyRenderShutdown(directory, executable) {
  const profile = path.join(directory, 'render shutdown profile');
  const temp = path.join(directory, 'render shutdown temp');
  await store.init(profile);
  fs.mkdirSync(temp);
  const project = store.createProject('渲染中断恢复', path.join(directory, 'render shutdown project'), templates[0]);
  const track = store.addTrack(project.id, 'subtitle', '字幕');
  const clip = store.addClip(track.id, { text: '已保存的时间线', duration: 0.5 });
  const app = executable || require('electron');
  const args = executable ? [] : ['.'];
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp };
  let interruptedId;
  let partial;
  let published;
  let publishedBytes;
  async function exportShort({ call, waitFor }) {
    const id = await call('export', project.id, 'landscape', false, 720, 24);
    const job = await waitFor(async () => {
      const record = (await call('project', project.id)).jobs.find(entry => entry.id === id);
      return record?.status !== 'queued' && record?.status !== 'rendering' && record;
    });
    assert.equal(job.status, 'done', job.detail);
    return JSON.parse(job.detail).file;
  }

  await desktopSession(app, args, profile, async session => {
    await session.openProject(project.name);
    published = await exportShort(session);
    publishedBytes = fs.readFileSync(published);
    await session.call('updateClip', clip.id, { duration: 1200 });
    interruptedId = await session.call('export', project.id, 'landscape', false, 720, 24);
    partial = path.join(project.dir, 'exports', `iModuReel-${interruptedId}.mp4.partial.mp4`);
    await session.waitFor(() => fs.existsSync(partial), '长视频导出未创建临时文件');
    await session.forceQuit();
  }, { env });

  const cleanup = () => !fs.existsSync(partial) && !fs.readdirSync(temp).some(name => name.startsWith('imodureel-render-'));
  const deadline = Date.now() + 8000;
  while (!cleanup() && Date.now() < deadline) await delay(100);
  assert.ok(cleanup(), '强制退出后仍有临时渲染文件');
  await desktopSession(app, args, profile, async session => {
    await session.openProject(project.name);
    const state = await session.call('project', project.id);
    assert.equal(state.jobs.find(entry => entry.id === interruptedId)?.status, 'interrupted');
    assert.equal(state.tracks[0].clips[0].duration, 1200);
    assert.deepEqual(fs.readFileSync(published), publishedBytes);
    await session.call('updateClip', clip.id, { duration: 0.5 });
    assert.equal((await probe(await exportShort(session))).duration, 0.5);
    await session.quit();
  }, { env });
  console.log('渲染中强制退出可清理临时文件，保留已发布成片和剪辑，重开后可继续导出');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      previous: { type: 'string' },
      installer: { type: 'string' }, 'previous-installer': { type: 'string' },
      dmg: { type: 'string' }, 'previous-dmg': { type: 'string' },
    },
  });
  const currentPackage = values.installer || values.dmg;
  const previousPackage = values['previous-installer'] || values['previous-dmg'];
  assert.ok(positionals.length <= 1 && [positionals[0], values.installer, values.dmg].filter(Boolean).length <= 1 &&
    (!values.previous || (positionals[0] || currentPackage) && !previousPackage) &&
    (!values['previous-installer'] || values.installer) && (!values['previous-dmg'] || values.dmg),
  '请选择可执行文件、--installer 或 --dmg。请为升级验收提供一个上一版安装包或可执行文件');
  const executable = positionals[0] && path.resolve(positionals[0]);
  const previous = values.previous && path.resolve(values.previous);
  assert.ok(!previous || previous !== executable, '升级验收需要两个版本的可执行文件');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'imodureel-smoke-'));
  try {
    let current = executable;
    if (currentPackage) {
      const installer = path.resolve(currentPackage);
      const earlier = previousPackage && path.resolve(previousPackage);
      assert.ok(earlier !== installer, '升级验收需要两个版本的安装包');
      const target = path.join(directory, 'Application under test');
      current = installDesktopPackage(earlier || installer, target);
      if (earlier) {
        const archive = installedArchive(current);
        const installed = fs.readFileSync(archive);
        return await verifyUpgrade(directory, current, current, () => {
          installDesktopPackage(installer, target);
          assert.ok(!installed.equals(fs.readFileSync(archive)), '升级后安装目录内的程序文件没有更新');
        });
      }
    }
    if (previous) return await verifyUpgrade(directory, previous, current);
    await smoke(directory, current);
    await verifyDraftRecovery(directory, current);
    await verifyEnhancementReview(directory, current);
    await verifyReferenceRevision(directory, current);
    await verifyRenderShutdown(directory, current);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
