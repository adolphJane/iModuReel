const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { createJobs } = require('../electron/jobs.cjs');
const engine = require('../electron/engine.cjs');
const media = require('../electron/media.cjs');
const { preset, presetModels } = require('../electron/presets.cjs');
const services = require('../electron/services.cjs');
const store = require('../electron/store.cjs');
const { templates, buildGeneration, shotDuration: shotDurationLimits, validateLtxShotDuration } = require('../electron/templates.cjs');
const { verifyDesktopTemplates } = require('./smoke-comfy-desktop.cjs');
const { installDesktopPackage } = require('./desktop-package.cjs');

function generateFixture(output, args) {
  execFileSync(media.resolveFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args, output]);
}

function makeFixtures(directory, args) {
  const source = args['source-video'] ? path.resolve(args['source-video']) : path.join(directory, 'source.mp4');
  const photo = args['product-image'] ? path.resolve(args['product-image']) : path.join(directory, 'product.png');
  if (!args['source-video']) {
    generateFixture(source, ['-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=24:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  }
  if (!args['product-image']) generateFixture(photo, ['-f', 'lavfi', '-i', 'color=0x2a756e:s=384x640', '-frames:v', '1']);
  return {
    source, photo,
    productDetails: {
      product: args['product-name'] || (args['product-image'] ? '商品样品' : 'Teal canvas jacket'),
      sellingPoints: args['product-selling-points'] || '展示款式和可见面料细节，设计两个简短镜头。',
    },
  };
}

async function stageRun(directory, run, fixtures) {
  const { template, reference } = run;
  const caseId = reference ? template.id + '-reference' : template.id;
  const project = store.createProject(reference ? '短剧制作（参考视频）' : template.name, path.join(directory, caseId), template);
  const bundle = structuredClone(run.bundle);
  const files = [];
  if (template.id === 'enhance') files.push(['sourceVideo', fixtures.source]);
  if (template.id === 'fashion') files.push(['productImage', fixtures.photo]);
  if (bundle.mapping.referenceImage) files.push(['referenceImage', fixtures.photo]);
  if (reference) files.push(['referenceVideo', reference]);
  const imported = await store.addMedia(project.id, await Promise.all(files.map(async ([, src]) => ({ src, ...await media.probe(src) }))));
  const details = template.id === 'fashion' ? fixtures.productDetails : template.id === 'drama' ? {
    script: reference ? '' : 'In a clock shop, Mina finds a silver key. She says, “This key opens the clock.” Kai switches on the lamp.',
  } : {};
  const inputs = Object.fromEntries(files.map(([role], index) => [role, imported[index].id]));
  return { template, caseId, project, bundle, imported, inputs, details, reference };
}

function reviewShot(suggested, duration) {
  return {
    ...suggested,
    title: '已审核开场',
    prompt: (suggested?.prompt || 'A slow camera push toward the subject in soft window light.') + ' Stable camera with no abrupt cut.',
    duration,
    dialogue: '已审核台词',
  };
}

async function prepareStoryboard(project, template, input, { image, reference, ai, details, shotDuration }) {
  store.saveProduction(project.id, { inputs: { ...input, ...details } });
  let suggested;
  if (ai) {
    const { shots, ...analysis } = await services.analyze(ai, template, details, { reference, productImage: image });
    assert.ok(analysis.summary.trim() && shots[0]?.prompt, '分析结果没有摘要或分镜');
    if (reference) assert.ok(analysis.sceneCuts.length, '参考视频没有返回镜头时间');
    if (image && ai.vision) assert.ok(analysis.productAppearance, '商品视觉分析没有返回外观字段');
    analysis.summary += '\n审核补充：保持镜头运动平稳。';
    const revised = await services.suggestShots(ai, template, analysis, details);
    store.saveProduction(project.id, { analysis, analysisShots: revised });
    suggested = revised[0];
    console.log(`${template.name}${reference ? '（参考视频）' : ''}：分析与修订分镜通过`);
  }
  const [approved] = store.setShots(project.id, [reviewShot(suggested, shotDuration)], true);
  return approved;
}

function checkVisiblePictures(file, frames, description) {
  const visibility = spawnSync(media.resolveFFmpeg(), [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:v:0',
    '-vf', 'blackframe=amount=99:threshold=24', '-an', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  assert.equal(visibility.status, 0, visibility.error?.message || visibility.stderr);
  const blackFrames = visibility.stderr.match(/Parsed_blackframe_\d+.*\bframe:\d+\s+pblack:/g)?.length ?? 0;
  assert.ok(blackFrames < frames, `${description}的所有画面均为黑帧`);
}

async function checkOutput(result, completed, run, scale) {
  const kind = run.bundle.id === 'still' ? 'image' : 'video';
  const output = result.assets.find(asset => asset.job_id === completed.id && asset.kind === kind);
  assert.ok(output?.exists, '生成产物未进入项目素材库');
  const analysis = await media.probe(output.path);
  assert.ok(analysis.video && (kind === 'image' || analysis.duration > 0));
  if (kind === 'image') {
    const { inputs } = Object.values(run.bundle.workflow).find(node =>
      ['EmptyLatentImage', 'ResizeAndPadImage'].includes(node.class_type));
    assert.deepEqual([analysis.width, analysis.height], [inputs.target_width ?? inputs.width, inputs.target_height ?? inputs.height],
      '静态镜头的分辨率与工作流不符');
    assert.equal(await media.countVideoFrames(output.path), 1, '静态镜头应能解码出一帧');
    checkVisiblePictures(output.path, 1, '静态镜头');
  }
  if (run.bundle.mapping.frameCount) {
    const { values } = JSON.parse(completed.detail);
    const encoder = Object.values(run.bundle.workflow).find(node => node.class_type === 'CreateVideo');
    assert.equal(analysis.fps, encoder.inputs.fps, '动态镜头的帧率与工作流不符');
    const { width, height } = run.bundle.workflow[run.bundle.mapping.frameCount.node].inputs;
    assert.deepEqual([analysis.width, analysis.height], [width, height], '动态镜头的分辨率与工作流不符');
    assert.equal(await media.countVideoFrames(output.path), values.frameCount, '动态镜头的帧数与审核后的镜头设置不符');
    checkVisiblePictures(output.path, values.frameCount, '动态镜头');
  }
  if (run.template.id === 'enhance') {
    const source = run.imported[0].path;
    const sourceInfo = await media.probe(source);
    assert.equal(analysis.audio, sourceInfo.audio, '处理前后音轨状态不一致');
    const swap = Math.abs(sourceInfo.rotation % 180) === 90;
    assert.equal(analysis.width, (swap ? sourceInfo.height : sourceInfo.width) * scale);
    assert.equal(analysis.height, (swap ? sourceInfo.width : sourceInfo.height) * scale);
    assert.deepEqual(analysis.sampleAspectRatio, swap ? sourceInfo.sampleAspectRatio.toReversed() : sourceInfo.sampleAspectRatio,
      '增强后的显示比例与源视频不符');
    assert.ok(Math.abs(analysis.duration - sourceInfo.duration) < 0.1, '处理后的视频时长偏差超过 0.1 秒');
    const batch = JSON.parse(completed.detail).enhancement;
    if (batch) {
      const frames = await media.countVideoFrames(output.path);
      assert.equal(frames, batch.segments.reduce((total, segment) => total + segment.frames, 0),
        '增强后应保留按源时间戳整理的全部帧');
      if (sourceInfo.fps && Math.abs(sourceInfo.fps - batch.fps) < 0.02) {
        assert.equal(frames, await media.countVideoFrames(source), '恒定帧率素材增强后应保留原帧数');
      }
      assert.ok(Math.abs(await media.enhancementVideoStart(output.path) - await media.enhancementVideoStart(source)) < 0.03,
        '处理前后画面起点偏差超过 0.03 秒');
    }
  }
  return { ...output, duration: analysis.duration };
}

function checkTimeline(restored, completed, output, reviewed) {
  assert.equal(restored.jobs.find(job => job.id === completed.id)?.status, 'done');
  assert.ok(restored.assets.find(asset => asset.id === output.id)?.exists);
  const shotClip = restored.tracks.find(track => track.kind === 'video')?.clips[0];
  assert.equal(shotClip?.asset_id, output.id);
  if (reviewed) {
    assert.equal(shotClip.duration, reviewed.duration, '入轨镜头的时长与审核值不符');
    const caption = restored.tracks.find(track => track.kind === 'subtitle')?.clips[0];
    assert.equal(caption?.text, reviewed.dialogue);
    assert.equal(caption?.linked_video_id, shotClip.id);
  }
}

async function checkExport(file, expectedDuration) {
  const encoded = await media.probe(file);
  assert.deepEqual([encoded.width, encoded.height, encoded.audio], [720, 1280, true]);
  if (expectedDuration !== undefined) {
    assert.ok(Math.abs(encoded.duration - expectedDuration) < 0.05,
      `导出时长 ${encoded.duration} 秒与审核的 ${expectedDuration} 秒不符`);
  }
}

function saveSamples(samples, run, output, exported, restored, reviewed) {
  if (!samples) return;
  const prefix = `${run.caseId}-${run.bundle.id}-${output.job_id.slice(0, 8)}`;
  if (run.imported.length) {
    const source = run.imported.at(-1).path;
    fs.copyFileSync(source, path.join(samples, prefix + '-input' + path.extname(source)), fs.constants.COPYFILE_EXCL);
  }
  fs.copyFileSync(output.path, path.join(samples, prefix + '-generated' + path.extname(output.path)), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(exported, path.join(samples, prefix + '-edit.mp4'), fs.constants.COPYFILE_EXCL);
  if (restored.production.analysis && reviewed) {
    const report = { analysis: restored.production.analysis, suggestions: restored.production.analysisShots, approved: reviewed };
    fs.writeFileSync(path.join(samples, prefix + '-analysis.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

async function waitForJob(id, timeout, stopAt = []) {
  const done = new Set([...stopAt, 'done', 'failed', 'disconnected', 'cancelled', 'interrupted']);
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const job = store.one('SELECT * FROM jobs WHERE id = ?', [id]);
    if (done.has(job.status)) return job;
    await delay(250);
  }
  throw new Error(`ComfyUI 任务超时：${id}`);
}

async function verifyPreflight(preflight, bundle) {
  const invalid = structuredClone(bundle.workflow);
  invalid['9999'] = { class_type: 'iModuReelAcceptanceMissingNode', inputs: {} };
  await assert.rejects(preflight(invalid, bundle.mapping), /实例缺少节点/);
  delete invalid['9999'];
  const checkpoint = Object.values(invalid).find(node => typeof node.inputs.ckpt_name === 'string');
  assert.ok(checkpoint, '取消测试需使用带 checkpoint 的镜头工作流');
  checkpoint.inputs.ckpt_name = 'imodureel-acceptance-missing.safetensors';
  await assert.rejects(preflight(invalid, bundle.mapping), /实例缺少模型/);
}

async function smoke() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' },
    desktop: { type: 'string' },
    dmg: { type: 'string' },
    installer: { type: 'string' },
    'external-engine': { type: 'boolean' },
    'engine-dir': { type: 'string' },
    'install-engine': { type: 'boolean' },
    'install-models': { type: 'boolean' },
    'package-index': { type: 'string' },
    'python-mirror': { type: 'string' },
    'model-source': { type: 'string', default: 'original' },
    suite: { type: 'string', default: 'transport' },
    template: { type: 'string' },
    preset: { type: 'string' },
    'ai-url': { type: 'string' },
    'ai-model': { type: 'string' },
    'transcription-model': { type: 'string', default: 'whisper-1' },
    'skip-transcription': { type: 'boolean' },
    'ai-vision': { type: 'boolean' },
    'job-checks': { type: 'boolean' },
    'reference-video': { type: 'string' },
    'product-image': { type: 'string' },
    'product-name': { type: 'string' },
    'product-selling-points': { type: 'string' },
    'source-video': { type: 'string' },
    'shot-duration': { type: 'string' },
    'output-dir': { type: 'string' },
    timeout: { type: 'string', default: '1800' },
  } });
  assert.ok(['transport', 'templates'].includes(values.suite), '请选择 transport 或 templates 验证套件');
  const timeout = Number(values.timeout);
  assert.ok(Number.isFinite(timeout) && timeout > 0, 'timeout 需要使用正数秒数');
  const shotDuration = Number(values['shot-duration'] ?? 1);
  assert.ok(Number.isFinite(shotDuration) && shotDuration >= shotDurationLimits.min && shotDuration <= shotDurationLimits.max,
    `shot-duration 必须介于 ${shotDurationLimits.min} 和 ${shotDurationLimits.max} 秒之间`);
  const engineDir = values['engine-dir'] && path.resolve(values['engine-dir']);
  const desktopPackage = values.dmg || values.installer;
  const desktopRequested = values.desktop || desktopPackage;
  assert.ok([values.desktop, values.dmg, values.installer].filter(Boolean).length <= 1, '请选择 --desktop、--dmg 或 --installer');
  assert.ok(!(engineDir && values.url), '请在 --engine-dir 和 --url 中选择一个');
  assert.ok(engineDir || !(values['install-engine'] || values['install-models']), '安装参数需要 --engine-dir');
  assert.ok(!desktopRequested || values.suite === 'templates', '桌面验收需要 --suite templates');
  assert.ok(!values['external-engine'] || desktopRequested && engineDir && !(values['install-engine'] || values['install-models']),
    '以外部方式启动已安装引擎需要桌面程序或安装包，以及 --engine-dir');
  assert.ok(['original', 'modelscope'].includes(values['model-source']), 'model-source 需要使用 original 或 modelscope');
  assert.equal(Boolean(values['ai-url']), Boolean(values['ai-model']), '请同时提供 --ai-url 与 --ai-model');
  const ai = values['ai-url'] && {
    url: services.baseUrl(values['ai-url']), model: values['ai-model'],
    apiKey: process.env.IMODUREEL_ACCEPTANCE_API_KEY,
    transcriptionModel: values['transcription-model'], transcriptionEnabled: !values['skip-transcription'], vision: values['ai-vision'],
  };
  assert.ok(!ai || (values.suite === 'templates' && ai.apiKey), 'AI 验收需要模板套件和 IMODUREEL_ACCEPTANCE_API_KEY');
  const reference = values['reference-video'] && path.resolve(values['reference-video']);
  assert.ok(!reference || ai, '参考视频验收需要配置 AI 服务');
  assert.ok(!reference || !values['skip-transcription'] || values['ai-vision'], '跳过语音转写时需要开启视觉分析');
  const cases = templates.filter(template =>
    (!values.template || values.template === template.id) && (values.suite === 'templates' || template.id === 'enhance'))
    .map(template => ({ template, bundle: preset(template.id, template.id === 'enhance' ? undefined : values.preset) }));
  assert.ok(cases.length, '指定的验证套件没有该项目模板');
  assert.ok(!values['shot-duration'] || cases.some(({ template }) => template.id !== 'enhance'), '镜头时长验收需要短剧或商品模板');
  if (cases.some(({ bundle }) => bundle.mapping.frameCount)) validateLtxShotDuration(shotDuration);
  assert.ok(!reference || cases.some(({ template }) => template.id === 'drama'), '参考视频验收需要短剧模板');
  assert.ok(!values['product-image'] || cases.some(({ template }) => template.id === 'fashion'), '商品参考图验收需要商品穿搭模板');
  assert.ok(!values['source-video'] || cases.some(({ template }) => template.id === 'enhance'), '源视频验收需要画质增强模板');
  assert.ok(!values['install-models'] || values.suite === 'templates', '传输验证无需安装模型');
  assert.ok(!values['job-checks'] ||
    ((engineDir || desktopRequested) && cases.some(({ template }) => template.id !== 'enhance')),
    '任务中断验证需要受管引擎或桌面应用，以及短剧或商品模板');
  assert.ok(!desktopRequested || !values['install-models'] || values['install-engine'], '桌面模板模型安装请与 --install-engine 一起使用');
  const runs = cases.flatMap(item => reference && item.template.id === 'drama'
    ? [item, { ...item, reference }] : [item]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'imodureel-comfy-smoke-'));
  const samples = values['output-dir'] ? path.resolve(values['output-dir']) : null;
  if (samples) fs.mkdirSync(samples, { recursive: true });
  const jobs = createJobs(event => { if (event.progress === undefined && !event.step) console.log(event.id, event.status); },
    { managedInstance: engine.runningInstance });
  let current;
  let checkJobs = values['job-checks'];
  try {
    const log = text => process.stdout.write(text);
    const desktop = desktopPackage ? installDesktopPackage(path.resolve(desktopPackage), path.join(directory, 'Application under test'))
      : values.desktop && path.resolve(values.desktop);
    const fixtures = makeFixtures(directory, values);
    if (desktop) {
      const profile = path.join(directory, 'desktop profile');
      await store.init(profile);
      const staged = [];
      for (const run of runs) staged.push(await stageRun(directory, run, fixtures));
      return await verifyDesktopTemplates({
        desktop, profile, engineDir, ai, timeout, values, runs: staged,
        reviewShot: suggested => reviewShot(suggested, shotDuration), verifyPreflight, checkOutput,
        checkTimeline, checkExport, saveSamples: (...args) => saveSamples(samples, ...args),
      });
    }
    const hardware = engineDir && await engine.info(engineDir);
    if (hardware) assert.ok(hardware.supported, hardware.name);
    if (values['install-engine']) await engine.install(engineDir, log, {
      packageIndex: values['package-index'], pythonMirror: values['python-mirror'],
    });
    if (values['install-models']) {
      const models = new Map(cases.flatMap(({ template, bundle }) => presetModels(template.id, bundle.id, values['model-source']))
        .map(model => [model.folder + '/' + model.name, model]));
      await engine.installModels(engineDir, [...models.values()], log);
    }
    const url = engineDir ? await engine.start(engineDir, log) : services.baseUrl(values.url);
    await services.checkComfy(url);
    if (hardware) {
      const response = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok, '无法确认受管引擎的实际运行设备');
      const { system, devices } = await response.json();
      const active = devices?.find(device => device.type === hardware.backend.toLowerCase());
      assert.ok(active, `受管引擎未使用 ${hardware.backend}`);
      console.log(`受管引擎 ${system.comfyui_version} 使用 ${hardware.backend} · ${active.name}`);
    }
    await store.init(directory);
    for (const run of runs) {
      const staged = await stageRun(directory, run, fixtures);
      const { template, reference: clip, project, bundle, inputs, imported, details } = staged;
      if (template.id === 'enhance') store.saveProduction(project.id, { inputs });
      const reviewed = template.id === 'enhance' ? null
        : await prepareStoryboard(project, template, inputs, {
          image: template.id === 'fashion' ? imported[0].path : null,
          reference: clip ? imported.at(-1).path : null,
          ai,
          details, shotDuration,
        });
      if (values.suite === 'transport') {
        // Exercise stock media nodes on a real ComfyUI instance without a model download.
        bundle.workflow['5'].inputs.images = ['2', 0];
        delete bundle.workflow['3'];
        delete bundle.workflow['4'];
      }
      store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
      const [payload] = buildGeneration(store.project(project.id), bundle, url, reviewed ? [reviewed.id] : []);
      if (reviewed) assert.ok(payload.values.prompt.startsWith(reviewed.prompt), '生成没有使用人工确认后的画面提示词');
      if (checkJobs && reviewed) await verifyPreflight((...args) => services.preflight(url, ...args), bundle);
      current = jobs.start(project.id, 'comfy', { ...payload, ...(engineDir ? { engineDir } : {}) });
      if (checkJobs && reviewed) {
        const running = await waitForJob(current.id, timeout, ['running']);
        assert.equal(running.status, 'running', running.detail);
        assert.equal((await jobs.cancel(current.id)).status, 'cancelled');
        await assert.rejects(services.waitPrompt(url, running.prompt_id, {
          signal: AbortSignal.timeout(timeout * 1000),
        }), /execution_interrupted/);
        current = jobs.retry(current.id);
        console.log('缺节点、缺模型、定向取消和重新提交通过');
        checkJobs = false;
      }
      const completed = await waitForJob(current.id, timeout);
      assert.equal(completed.status, 'done', completed.detail);
      const output = await checkOutput(store.project(project.id), completed, staged, values.suite === 'templates' ? 4 : 1);
      if (reviewed) await store.appendStoryboard(project.id);
      else {
        const result = store.assets(project.id).find(asset => asset.id === output.id);
        store.approveEnhancement(project.id, result.id, result.revision);
        const track = store.addTrack(project.id, 'video', '素材轨');
        store.addClip(track.id, { asset_id: output.id, duration: Math.min(1, output.duration || 1) });
      }
      await store.init(directory);
      const restored = store.project(project.id);
      checkTimeline(restored, completed, output, reviewed);
      const exported = await media.exportVideo(restored, { format: 'portrait' });
      await checkExport(exported, reviewed?.duration);
      saveSamples(samples, staged, output, exported, restored, reviewed);
      console.log(`${template.name}${clip ? '（参考视频）' : ''}：提交工作流、入库、重开项目和 720p 剪辑导出通过`);
      current = null;
    }
  } finally {
    if (current && ['queued', 'preparing', 'running', 'collecting', 'reconnecting', 'disconnected'].includes(current.status)) {
      await jobs.cancel(current.id).catch(error => console.error('取消远端测试任务失败', error.message));
    }
    jobs.stop();
    if (engineDir) await engine.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

smoke().catch(error => { console.error(error); process.exitCode = 1; });
