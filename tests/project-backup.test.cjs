const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createBackup, restoreBackup, manifestName } = require('../electron/project-backup.cjs');
const { createJobs } = require('../electron/jobs.cjs');
const { assetFingerprint } = require('../electron/asset-file.cjs');
const { preset } = require('../electron/presets.cjs');
const media = require('../electron/media.cjs');
const services = require('../electron/services.cjs');
const store = require('../electron/store.cjs');
const { buildGeneration, templates } = require('../electron/templates.cjs');

const ffmpeg = media.resolveFFmpeg();
const hasFFmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;

async function fixtureDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imodureel-backup-test-'));
  t.after(() => fs.rm(root, { force: true, recursive: true, maxRetries: 3 }));
  return root;
}

test('a portable project preserves saved work and unfinished edits across profiles', { skip: !hasFFmpeg }, async t => {
  const root = await fixtureDirectory(t);
  const origin = path.join(root, 'original profile'), destination = path.join(root, 'restored profile');
  await store.init(origin);
  const project = store.createProject('商品备份验收', path.join(root, 'original project'), templates[1]);
  const source = path.join(root, 'red.png');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', source]);
  const [input, absent] = await store.addMedia(project.id, [
    { src: source, kind: 'image' }, { src: source, kind: 'image' },
  ]);
  await fs.unlink(absent.path);
  store.saveInputs(project.id, 'fashion', { product: '红色短袖', sellingPoints: '棉质', productImage: input.id });
  const [shot] = store.setShots(project.id, [{ title: '首镜头', prompt: 'Red cotton', duration: 1, dialogue: '棉质短袖' }], true);
  const bundle = preset('fashion', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [payload] = buildGeneration(store.project(project.id), bundle, 'http://127.0.0.1:49152', [shot.id]);
  payload.engineDir = path.join(root, 'old engine');
  const completed = store.addJob(project.id, 'comfy', payload);
  const [output] = await store.addMedia(project.id, [{
    src: source, kind: 'image', origin: 'comfy', jobId: completed.id, outputKey: 'generated-file',
  }]);
  store.updateJob(completed.id, { status: 'done', prompt_id: 'old-engine-prompt', detail: JSON.stringify({ ...payload, assets: [output.id] }) });
  await store.appendStoryboard(project.id);
  const captionTrack = store.project(project.id).tracks.find(track => track.kind === 'subtitle');
  store.renameTrack(project.id, captionTrack.id, '审核字幕');
  store.moveTrack(project.id, captionTrack.id, -1);
  store.saveProduction(project.id, {
    analysis: { summary: '经过人工校对的商品分析', characters: [], scenes: [], sceneCuts: [], productAppearance: { color: '红色' } },
    analysisShots: [{ ...shot, title: '新建议' }],
    draftShots: [{ ...shot, title: '待审核草稿' }],
    exportSettings: { format: 'portrait', resolution: 720, fps: 24 },
  });
  const timeline = store.project(project.id);
  const file = await media.exportVideo(timeline, timeline.production.exportSettings);
  const exportRequest = {
    ...timeline.production.exportSettings, snapshot: { dir: timeline.dir, tracks: timeline.tracks, assets: [output] },
  };
  const rendered = store.addJob(project.id, 'export', exportRequest);
  store.updateJob(rendered.id, { status: 'done', detail: JSON.stringify({ ...JSON.parse(rendered.detail), file }) });
  const emptyFile = path.join(timeline.dir, 'exports', 'empty.mp4');
  await fs.writeFile(emptyFile, '');
  const unavailable = store.addJob(project.id, 'export', { ...exportRequest, file: emptyFile });
  store.updateJob(unavailable.id, { status: 'done' });
  const queued = store.addJob(project.id, 'comfy', { ...payload, batchId: 'old-queue' });
  store.updateJob(queued.id, { status: 'disconnected', prompt_id: 'old-queue-prompt' });
  store.setSetting('ai', { apiKey: 'private-profile-test-key' });
  const caption = timeline.tracks.find(track => track.kind === 'subtitle').clips[0];
  const unfinishedInputs = { product: '新商品名称', sellingPoints: '', productImage: absent.id };
  const unfinishedAnalysis = { ...timeline.production.analysis, summary: '继续校对', scenes: [{ title: '', description: '' }] };
  const addedShot = { id: store.id(), title: '', prompt: '', duration: 0, dialogue: '' };
  const unfinishedWorkflow = { workflow: '{"nodes":', mapping: '' };
  store.saveEditorDraft(project.id, 'inputs', unfinishedInputs);
  store.saveEditorDraft(project.id, 'analysis', unfinishedAnalysis);
  store.saveEditorDraft(project.id, 'shots', [{ ...shot, duration: 0, prompt: '' }, addedShot]);
  store.saveEditorDraft(project.id, 'workflow', unfinishedWorkflow);
  store.saveEditorDraft(project.id, 'clip', { ...caption, duration: 0, text: '待校对台词' });
  const backup = await createBackup(project.id, root);
  assert.equal(backup.missingAssets, 1);
  assert.equal(backup.missingRenders, 1);
  const record = path.join(backup.directory, manifestName);
  const serialized = await fs.readFile(record, 'utf8');
  const manifest = JSON.parse(serialized);
  assert.equal(manifest.version, 9);
  assert.deepEqual(manifest.jobWorkflows, [{ workflow: bundle.workflow, mapping: bundle.mapping }]);
  assert.ok(manifest.jobs.filter(job => job.kind === 'comfy').every(job => job.detail.workflowIndex === 0 && !job.detail.workflow));
  for (const value of [input.path, payload.engineDir, payload.url, 'old-engine-prompt', 'old-queue', 'private-profile-test-key']) {
    assert.equal(serialized.includes(value), false);
  }

  await store.init(destination);
  assert.equal(store.all('SELECT * FROM projects').length, 0);
  const restored = await restoreBackup(record, root);
  assert.equal(restored.missingAssets, 1);
  assert.notEqual(restored.project.id, project.id);
  assert.equal(store.getSetting('ai'), null);
  const invalidIndex = { ...manifest, jobs: manifest.jobs.map(job => job.kind === 'comfy'
    ? { ...job, detail: { ...job.detail, workflowIndex: 1 } } : job) };
  const earlier = path.join(backup.directory, 'inline-workflow-backup.json');
  await fs.writeFile(earlier, JSON.stringify(invalidIndex));
  await assert.rejects(restoreBackup(earlier, root), /任务工作流引用无效/);
  await fs.writeFile(earlier, JSON.stringify({ ...manifest, version: 2, jobWorkflows: undefined, timelineHistory: undefined,
    jobs: manifest.jobs.map(job => {
      const { workflowIndex, ...detail } = job.detail;
      return { ...job, detail: { ...detail, ...manifest.jobWorkflows[workflowIndex] } };
    }),
  }));
  const duplicate = await restoreBackup(earlier, root);
  assert.notEqual(duplicate.project.id, restored.project.id);
  await store.init(destination);
  const current = store.project(restored.project.id);
  assert.equal(current.template_snapshot, project.template_snapshot);
  assert.deepEqual(store.loadWorkflow(current.id), { workflow: bundle.workflow, mapping: bundle.mapping });
  assert.equal(current.production.analysis.productAppearance.color, '红色');
  assert.equal(current.production.draftShots[0].id, current.shots[0].id);
  assert.equal(current.production.draftShots[0].title, '待审核草稿');
  assert.equal(current.production.analysisShots[0].title, '新建议');
  assert.equal(current.shots[0].status, 'approved');
  assert.notEqual(current.shots[0].id, shot.id);
  const newInput = current.assets.find(asset => asset.id === current.production.inputs.productImage);
  assert.ok(newInput.exists && newInput.id !== input.id && newInput.path.startsWith(current.dir + path.sep));
  assert.equal(current.assets.filter(asset => !asset.exists).length, 1);
  assert.deepEqual(current.tracks.map(track => [track.kind, track.name]), [['subtitle', '审核字幕'], ['video', '视频 1']]);
  const video = current.tracks.find(track => track.kind === 'video').clips[0];
  const subtitle = current.tracks.find(track => track.kind === 'subtitle').clips[0];
  assert.equal(subtitle.linked_video_id, video.id);
  assert.equal(subtitle.text, '棉质短袖');
  const drafts = current.editorDrafts;
  const missingInput = current.assets.find(asset => !asset.exists);
  assert.deepEqual(drafts.inputs, { ...unfinishedInputs, productImage: missingInput.id });
  assert.deepEqual(drafts.analysis, unfinishedAnalysis);
  assert.deepEqual(drafts.shots[0], { ...shot, id: current.shots[0].id, duration: 0, prompt: '' });
  const duplicateDraft = store.project(duplicate.project.id).editorDrafts.shots[1];
  assert.notEqual(drafts.shots[1].id, addedShot.id);
  assert.notEqual(drafts.shots[1].id, duplicateDraft.id);
  assert.deepEqual(drafts.shots[1], { ...addedShot, id: drafts.shots[1].id });
  assert.deepEqual(drafts.workflow, unfinishedWorkflow);
  assert.deepEqual(drafts.clip, { ...subtitle, duration: 0, text: '待校对台词' });
  assert.ok(current.assets.some(asset => asset.id === video.asset_id && asset.exists));
  const videoJob = current.jobs.find(job => job.kind === 'comfy' && job.status === 'done');
  assert.deepEqual(JSON.parse(videoJob.detail).assets, [video.asset_id]);
  assert.equal(JSON.parse(videoJob.detail).shotId, current.shots[0].id);
  assert.equal(current.assets.find(asset => asset.id === video.asset_id).job_id, videoJob.id);
  const exportJob = current.jobs.find(job => job.kind === 'export' && job.status === 'done');
  const exported = JSON.parse(exportJob.detail);
  assert.equal(exported.fps, 24);
  assert.equal(exported.snapshot.dir, current.dir);
  assert.deepEqual(await fs.readFile(exported.file), await fs.readFile(file));
  const unavailableExport = current.jobs.find(job => job.kind === 'export' && job.status === 'interrupted');
  assert.equal(JSON.parse(unavailableExport.detail).file, undefined);
  assert.deepEqual(JSON.parse(unavailableExport.detail).snapshot.tracks, exported.snapshot.tracks);
  const encoded = await media.probe(await media.exportVideo(current, current.production.exportSettings));
  assert.deepEqual([encoded.width, encoded.height, encoded.duration, encoded.fps], [720, 1280, 1, 24]);

  const interrupted = current.jobs.find(job => job.kind === 'comfy' && job.status === 'interrupted');
  assert.equal(interrupted.prompt_id, null);
  assert.equal(JSON.parse(interrupted.detail).useCurrentEngine, true);
  assert.equal(JSON.parse(interrupted.detail).remoteStatusUnknown, true);
  const retryUrl = 'http://127.0.0.1:56789';
  t.mock.method(services, 'uploadAsset', async (url, asset) => {
    assert.equal(url, retryUrl);
    assert.equal(asset.path, newInput.path);
    return 'test-input.png';
  });
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async url => { assert.equal(url, retryUrl); });
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => ({ prompt_id: promptId }));
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'validated' }]);
  const scheduler = createJobs(() => {});
  const retry = scheduler.retry(interrupted.id, { url: retryUrl });
  assert.equal(JSON.parse(retry.detail).url, retryUrl);
  for (let index = 0; index < 50; index++) {
    if (store.project(current.id).jobs.find(job => job.id === retry.id)?.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(store.project(current.id).jobs.find(job => job.id === retry.id).status, 'done');
});

test('a portable backup restores editable work when finished exports are lost or corrupted in transit', { skip: !hasFFmpeg }, async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'original profile'));
  const project = store.createProject('成片恢复验收', path.join(root, 'original project'), templates[0]);
  const track = store.addTrack(project.id, 'subtitle', '字幕');
  store.addClip(track.id, { start: 0, duration: 0.5, text: '可重新导出的时间线' });
  const snapshot = store.project(project.id);
  const options = { format: 'portrait', resolution: 720, fps: 24 };
  const file = await media.exportVideo(snapshot, options);
  for (let index = 0; index < 3; index++) {
    const job = store.addJob(project.id, 'export', { ...options, snapshot, file });
    store.updateJob(job.id, { status: 'done' });
  }
  const backup = await createBackup(project.id, root);
  assert.equal(backup.missingRenders, 0);
  const record = path.join(backup.directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(record, 'utf8'));
  const exports = manifest.jobs.map(job => job.detail);
  const fingerprint = await assetFingerprint(file);
  const saved = exports.map(detail => path.join(backup.directory, 'renders', detail.file));
  await store.init(path.join(root, 'restored profile'));

  const legacyRecord = path.join(backup.directory, 'legacy-export.json');
  const legacy = structuredClone(manifest);
  for (const job of legacy.jobs) delete job.detail.fileSha256;
  await fs.writeFile(legacyRecord, JSON.stringify(legacy));
  const previous = await restoreBackup(legacyRecord, root);
  assert.equal(store.project(previous.project.id).jobs.filter(job => job.status === 'done').length, 3);

  const changed = await fs.readFile(saved[0]);
  changed[changed.length - 1] ^= 1;
  await fs.writeFile(saved[0], changed);
  await fs.unlink(saved[1]);
  const restored = await restoreBackup(record, root);
  assert.equal(restored.missingRenders, 2);
  assert.ok(exports.every(detail => detail.fileSha256 === fingerprint));
  const current = store.project(restored.project.id);
  assert.equal(current.tracks[0].clips[0].text, '可重新导出的时间线');
  const intact = current.jobs.find(job => job.status === 'done');
  const interrupted = current.jobs.filter(job => job.status === 'interrupted');
  assert.equal(interrupted.length, 2);
  assert.deepEqual(await fs.readFile(JSON.parse(intact.detail).file), await fs.readFile(file));
  assert.deepEqual(await fs.readFile(saved[0]), changed);
  for (const record of interrupted) {
    const detail = JSON.parse(record.detail);
    assert.equal(detail.file, undefined);
    assert.equal(detail.fps, 24);
    assert.equal(detail.snapshot.dir, current.dir);
    assert.deepEqual(detail.snapshot.tracks[0].clips, current.tracks[0].clips);
  }
  assert.equal((await fs.readdir(path.join(current.dir, 'exports'))).length, 1);

  const scheduler = createJobs(() => {});
  t.after(() => scheduler.stop());
  const retry = await scheduler.retry(interrupted[0].id);
  const deadline = Date.now() + 10000;
  let rerender;
  while (Date.now() < deadline) {
    rerender = store.project(current.id).jobs.find(job => job.id === retry.id);
    if (rerender.status === 'done' || rerender.status === 'failed') break;
    await delay(50);
  }
  assert.equal(rerender.status, 'done', rerender.detail);
  assert.equal((await media.probe(JSON.parse(rerender.detail).file)).fps, 24);
  if (process.platform !== 'win32') {
    await fs.unlink(saved[0]);
    await fs.symlink(file, saved[0]);
    await assert.rejects(restoreBackup(record, root), /媒体文件不在备份目录内/);
  }
});

test('portable exports preserve historical sources and require consent when an older backup lacks them', async t => {
  const root = await fixtureDirectory(t);
  const origin = path.join(root, 'origin');
  await store.init(origin);
  const project = store.createProject('Historical sources', path.join(root, 'project'), templates[0]);
  const first = path.join(root, 'original.png');
  const second = path.join(root, 'replacement.png');
  await fs.writeFile(first, 'original media');
  await fs.writeFile(second, 'replacement media');
  const [asset] = await store.addMedia(project.id, [{ src: first, kind: 'image' }]);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: asset.id, duration: 1 });
  const { dir, assets, tracks } = store.project(project.id);
  store.addJobs(project.id, 'export', Array.from({ length: 2 }, () => ({ snapshot: { dir, assets, tracks } })));
  await store.relinkAsset(asset.id, second, { kind: 'image' });

  const backup = await createBackup(project.id, root);
  const record = path.join(backup.directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(manifest.version, 9);
  const names = await fs.readdir(path.join(backup.directory, 'history'));
  assert.equal(names.length, 1);
  assert.ok(manifest.jobs.every(job => job.detail.snapshot.assets[0].file === names[0]));
  const workflow = { '1': { class_type: 'ExampleNode', inputs: { text: '' } } };
  const mapping = { prompt: { node: '1', input: 'text' } };
  store.addJob(project.id, 'comfy', { workflow, mapping, values: { prompt: 'Sample' }, assetInputs: {} });
  const mixed = await createBackup(project.id, root);
  await store.init(path.join(root, 'restored'));
  const { project: restored } = await restoreBackup(record, root);
  const current = store.project(restored.id);
  const paths = current.jobs.map(job => JSON.parse(job.detail).snapshot.assets[0].path);
  assert.equal(paths[0], paths[1]);
  assert.equal(await fs.readFile(paths[0], 'utf8'), 'original media');
  assert.equal(await fs.readFile(current.assets[0].path, 'utf8'), 'replacement media');
  const { project: mixedProject } = await restoreBackup(path.join(mixed.directory, manifestName), root);
  const both = store.project(mixedProject.id);
  const historical = JSON.parse(both.jobs.find(job => job.kind === 'export').detail).snapshot.assets[0].path;
  assert.equal(await fs.readFile(historical, 'utf8'), 'original media');
  const generation = JSON.parse(both.jobs.find(job => job.kind === 'comfy').detail);
  assert.deepEqual(store.jobWorkflow(generation.workflowRef), { workflow, mapping });

  manifest.version = 1;
  delete manifest.timelineHistory;
  for (const job of manifest.jobs) delete job.detail.snapshot.assets[0].file;
  const earlierRecord = path.join(backup.directory, 'earlier-backup.json');
  await fs.writeFile(earlierRecord, JSON.stringify(manifest));
  const { project: earlier } = await restoreBackup(earlierRecord, root);
  const earlierProject = store.project(earlier.id);
  const [job] = earlierProject.jobs;
  assert.equal(JSON.parse(job.detail).snapshot.assets[0].path, null);
  assert.deepEqual((await createJobs(() => {}).retry(job.id)).replacements,
    [{ id: earlierProject.assets[0].id, name: 'original.png', revision: 1 }]);
});

test('locating an original asset after portable restore keeps review and permits retry', async t => {
  const root = await fixtureDirectory(t);
  const original = path.join(root, 'reference.png');
  const renamed = path.join(root, 'renamed-reference.png');
  await fs.writeFile(original, 'original product photo');
  await fs.copyFile(original, renamed);
  await store.init(path.join(root, 'source'));
  const project = store.createProject('Restore reviewed inputs', path.join(root, 'project'), templates[1]);
  const [asset] = await store.addMedia(project.id, [{ src: original, kind: 'image' }]);
  store.saveInputs(project.id, 'fashion', { productImage: asset.id });
  const [shot] = store.setShots(project.id, [{ title: 'Opening', prompt: 'A red shirt', duration: 1 }], true);
  store.saveProduction(project.id, { analysisShots: [{ title: 'Ad', prompt: 'Closeup', duration: 1 }] });
  const bundle = preset('fashion', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const url = 'http://127.0.0.1:56789';
  const [request] = buildGeneration(store.project(project.id), bundle, url, [shot.id]);
  const failed = store.addJob(project.id, 'comfy', request);
  store.updateJob(failed.id, { status: 'failed' });
  await fs.unlink(asset.path);
  const exported = await createBackup(project.id, root);
  assert.equal(exported.missingAssets, 1);
  await store.init(path.join(root, 'target'));
  const { project: target } = await restoreBackup(path.join(exported.directory, manifestName), root);
  let restored = store.project(target.id);
  const originalRevision = restored.production.reviewedInputRevision;
  const recovered = restored.assets[0];
  assert.equal(recovered.sha256, asset.sha256);
  await store.relinkAsset(recovered.id, renamed, { kind: 'image' });
  restored = store.project(target.id);
  assert.equal(restored.assets[0].revision, 0);
  assert.equal(restored.production.inputRevision, originalRevision);
  assert.equal(restored.production.analysisShots.length, 1);
  const [next] = buildGeneration(restored, bundle, url, [restored.shots[0].id]);
  assert.equal(next.assetRevisions.productImage, 0);

  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'uploadAsset', async (_, asset) => {
    assert.equal(asset.id, recovered.id);
    assert.equal(await fs.readFile(asset.path, 'utf8'), 'original product photo');
    return 'uploaded.png';
  });
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'submitPrepared', async (_, __, { promptId }) => ({ prompt_id: promptId }));
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'output' }]);
  const retry = createJobs(() => {}).retry(restored.jobs[0].id, { url });
  for (let count = 0; count < 100 && store.one('SELECT status FROM jobs WHERE id = ?', [retry.id]).status !== 'done'; count++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [retry.id]).status, 'done');

  await fs.writeFile(renamed, 'replacement product photo');
  await store.relinkAsset(recovered.id, renamed, { kind: 'image' });
  const changed = store.project(target.id);
  assert.equal(changed.assets[0].revision, 1);
  assert.equal(changed.production.inputRevision, originalRevision + 1);
  assert.equal(changed.production.analysisShots.length, 0);
  assert.throws(() => buildGeneration(changed, bundle, url, [changed.shots[0].id]), /分析输入已变更/);
});

test('portable backups remap approved enhancement versions without approving newer replacements', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'source'));
  const project = store.createProject('Enhanced revisions', path.join(root, 'project'), templates[2]);
  const paths = ['original.mp4', 'second.mp4', 'replacement.mp4'].map(name => path.join(root, name));
  for (const file of paths) await fs.writeFile(file, path.basename(file));
  const [first, second] = await store.addMedia(project.id, paths.slice(0, 2)
    .map(src => ({ src, kind: 'video', duration: 1, origin: 'comfy' })));
  store.approveEnhancement(project.id, first.id, 0);
  store.approveEnhancement(project.id, second.id, 0);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: first.id });
  await store.relinkAsset(first.id, paths[2], { kind: 'video', duration: 1 });

  const backup = await createBackup(project.id, root);
  await store.init(path.join(root, 'target'));
  const { project: target } = await restoreBackup(path.join(backup.directory, manifestName), root);
  const restored = store.project(target.id);
  const updated = restored.assets.find(asset => asset.name === 'replacement.mp4');
  const approved = restored.assets.find(asset => asset.name === 'second.mp4');
  assert.notEqual(updated.id, first.id);
  assert.notEqual(approved.id, second.id);
  assert.equal(updated.revision, 1);
  assert.equal(updated.enhancementReviewRequired, true);
  assert.equal(approved.enhancementReviewRequired, false);
  assert.equal(restored.tracks[0].clips[0].asset_id, updated.id);
});

test('rough cut distinguishes a replaced generated file from the original across backup and restore', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'source profile'));
  const project = store.createProject('Generated version', path.join(root, 'project'), templates[0]);
  const original = path.join(root, 'original.png');
  const alternate = path.join(root, 'alternate.png');
  await fs.writeFile(original, 'original generated content');
  await fs.writeFile(alternate, 'manually supplied content');
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [shot] = store.setShots(project.id, [{ prompt: 'A generated still', duration: 1 }], true);
  const [payload] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
  const job = store.addJob(project.id, 'comfy', payload);
  const [result] = await store.addMedia(project.id, [{ src: original, kind: 'image', origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [result.id] }) });

  await fs.copyFile(alternate, result.path);
  await assert.rejects(store.appendStoryboard(project.id), /素材内容已变更/);
  await store.relinkAsset(result.id, alternate, { kind: 'image' });
  await assert.rejects(store.appendStoryboard(project.id), /没有对应的可用结果/);
  assert.equal(store.project(project.id).tracks.length, 0);
  const backup = await createBackup(project.id, root);
  await store.init(path.join(root, 'target profile'));
  const { project: target } = await restoreBackup(path.join(backup.directory, manifestName), root);
  const [restored] = store.assets(target.id);
  assert.equal(restored.generated_sha256, result.sha256);
  assert.notEqual(restored.generated_sha256, restored.sha256);
  await assert.rejects(store.appendStoryboard(target.id), /没有对应的可用结果/);
  await store.relinkAsset(restored.id, original, { kind: 'image' });
  assert.equal((await store.appendStoryboard(target.id)).clips, 1);
  assert.equal(store.project(target.id).tracks[0].clips[0].asset_id, restored.id);
});

test('a selected older shot version survives reopening and portable restore', async t => {
  const root = await fixtureDirectory(t);
  const profile = path.join(root, 'profile');
  await store.init(profile);
  const project = store.createProject('Shot versions', path.join(root, 'project'), templates[0]);
  const [shot] = store.setShots(project.id, [{ title: 'Arrival', prompt: 'Arrival in daylight', duration: 1 }], true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const outputs = [];
  for (const [index, name] of ['older.png', 'newer.png'].entries()) {
    const src = path.join(root, name);
    await fs.writeFile(src, name);
    const [payload] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id], index === 1);
    const job = store.addJob(project.id, 'comfy', payload);
    const [asset] = await store.addMedia(project.id, [{ src, kind: 'image', origin: 'comfy', jobId: job.id }]);
    store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [asset.id] }) });
    outputs.push({ asset, seed: payload.values.seed });
  }
  const [older, newer] = outputs;
  const options = () => store.storyboardResults(project.id).shots[0];
  assert.deepEqual(options().candidates.map(item => item.assetId), [newer.asset.id, older.asset.id]);
  assert.equal(options().candidates[0].seed, newer.seed);
  await assert.rejects(store.chooseShotResult(project.id, shot.id, 'outside-project'), /所选版本已不可用/);
  await store.chooseShotResult(project.id, shot.id, older.asset.id);
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === older.asset.id), false);
  await store.init(profile);
  assert.equal(options().selectedAssetId, older.asset.id);
  assert.equal((await store.appendStoryboard(project.id)).clips, 1);
  const edited = store.project(project.id).tracks[0].clips[0];
  store.updateClip(edited.id, { start: 0.25, duration: 0.75, transition: 'fade' });

  const backup = await createBackup(project.id, root);
  const manifestPath = path.join(backup.directory, manifestName);
  assert.equal(JSON.parse(await fs.readFile(manifestPath)).version, 9);
  await store.init(path.join(root, 'restore profile'));
  const { project: restored } = await restoreBackup(manifestPath, root);
  const assets = new Map(store.assets(restored.id).map(asset => [asset.name, asset]));
  const state = store.storyboardResults(restored.id).shots[0];
  assert.notEqual(state.shotId, shot.id);
  assert.equal(state.selectedAssetId, assets.get('older.png').id);
  assert.equal(state.candidates[0].seed, newer.seed);
  const [restoredClip] = store.project(restored.id).tracks[0].clips;
  assert.deepEqual(state.timelineClipIds, [restoredClip.id]);
  assert.equal(restoredClip.asset_id, assets.get('older.png').id);

  await fs.unlink(assets.get('older.png').path);
  await assert.rejects(store.appendStoryboard(restored.id), /已选版本不可用/);
  assert.equal(store.project(restored.id).tracks[0].clips.length, 1);
  assert.equal(await store.replaceShotVersion(restored.id, state.shotId, assets.get('newer.png').id, restoredClip.id), 1);
  assert.deepEqual(store.project(restored.id).tracks[0].clips[0], { ...restoredClip, asset_id: assets.get('newer.png').id });
  assert.equal(store.storyboardResults(restored.id).shots[0].selectedAssetId, assets.get('older.png').id);
  await store.chooseShotResult(restored.id, state.shotId, null);
  assert.equal((await store.appendStoryboard(restored.id)).clips, 1);
  assert.equal(store.project(restored.id).tracks[0].clips[1].asset_id, assets.get('newer.png').id);
});

test('a portable backup remaps linked dialogue in the timeline and preserves the selected shot audio', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'voice profile'));
  const project = store.createProject('Portable voice', path.join(root, 'source project'), templates[0]);
  const footage = path.join(root, 'scene.mp4');
  const voiceFile = path.join(root, 'line.wav');
  await fs.writeFile(footage, 'fixture video');
  await fs.writeFile(voiceFile, 'fixture sound');
  const [voice, pendingVoice] = await store.addMedia(project.id, ['Dialogue', 'Alternative'].map(name => ({
    src: voiceFile, kind: 'audio', duration: 0.75, name,
  })));
  const [shot] = store.setShots(project.id, [{
    title: 'Voice attached', prompt: 'Opening scene', duration: 1, dialogue: 'Welcome', dialogue_audio_id: voice.id,
  }], true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [request] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
  const job = store.addJob(project.id, 'comfy', request);
  const [generated] = await store.addMedia(project.id, [{ src: footage, kind: 'video', duration: 2, origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...request, assets: [generated.id] }) });
  await store.appendStoryboard(project.id);
  const clip = store.project(project.id).tracks.find(track => track.kind === 'video').clips[0];
  store.splitClip(clip.id, 0.5, 24);
  store.saveProduction(project.id, { draftShots: [{ ...shot, dialogue_audio_id: pendingVoice.id }] });
  store.saveEditorDraft(project.id, 'shots', [{ ...shot, dialogue_audio_id: pendingVoice.id }]);
  const exported = await createBackup(project.id, root);
  const record = path.join(exported.directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(manifest.version, 9);

  await store.init(path.join(root, 'destination profile'));
  const { project: target } = await restoreBackup(record, root);
  const recovered = store.project(target.id);
  const sources = new Map(recovered.assets.map(asset => [asset.name, asset.id]));
  assert.notEqual(sources.get('Dialogue'), voice.id);
  assert.equal(recovered.shots[0].dialogue_audio_id, sources.get('Dialogue'));
  assert.equal(recovered.production.draftShots[0].dialogue_audio_id, sources.get('Alternative'));
  assert.equal(recovered.editorDrafts.shots[0].dialogue_audio_id, sources.get('Alternative'));
  const audio = recovered.tracks.find(track => track.kind === 'audio').clips;
  const video = recovered.tracks.find(track => track.kind === 'video').clips;
  assert.deepEqual(audio.map(clip => [clip.start, clip.in_point, clip.asset_id, clip.linked_video_id]),
    [[0, 0, sources.get('Dialogue'), video[0].id], [0.5, 0.5, sources.get('Dialogue'), video[1].id]]);
  store.stepTimeline(target.id, 'undo');
  const [unsplit] = store.project(target.id).tracks.find(track => track.kind === 'audio').clips;
  assert.deepEqual([unsplit.id, unsplit.duration, unsplit.linked_video_id], [audio[0].id, 0.75, video[0].id]);
  await store.init(path.join(root, 'destination profile'));
  assert.equal(store.timelineHistory(target.id, store.project(target.id).tracks).redo, '拆分片段');
  store.stepTimeline(target.id, 'redo');
  assert.deepEqual(store.project(target.id).tracks.find(track => track.kind === 'audio').clips, audio);
  store.updateClip(video[1].id, { start: 1.5 });
  assert.equal(store.project(target.id).tracks.find(track => track.kind === 'audio').clips[1].start, 1.5);

  delete manifest.timelineHistory;
  await fs.writeFile(record, JSON.stringify({ ...manifest, version: 8 }));
  const { project: legacy } = await restoreBackup(record, root);
  assert.deepEqual(store.timelineHistory(legacy.id, store.project(legacy.id).tracks), {});
  assert.equal(store.project(legacy.id).tracks.find(track => track.kind === 'audio').clips.length, 2);
  await fs.writeFile(record, JSON.stringify({ ...manifest, version: 7 }));
  await assert.rejects(restoreBackup(record, root), /时间线片段引用无效/);

  store.updateClip(video[1].id, { in_point: 0.8 });
  const trimmed = await createBackup(target.id, root);
  const trimmedRecord = path.join(trimmed.directory, manifestName);
  const v10 = JSON.parse(await fs.readFile(trimmedRecord, 'utf8'));
  assert.equal(v10.version, 10);
  assert.equal(v10.tracks.find(track => track.kind === 'audio').clips[1].duration, 0);
  await store.init(path.join(root, 'trimmed destination'));
  const { project: restored } = await restoreBackup(trimmedRecord, root);
  const [hidden] = store.hiddenDialogue(restored.id);
  const currentAudio = () => store.project(restored.id).tracks.find(track => track.kind === 'audio').clips;
  assert.equal(currentAudio().length, 1);
  assert.equal(store.timelineHistory(restored.id).undo, '修改片段');
  store.stepTimeline(restored.id, 'undo');
  const rightVoice = currentAudio().find(clip => clip.linked_video_id === hidden.videoId);
  assert.deepEqual([rightVoice.start, rightVoice.in_point, rightVoice.duration], [1.5, 0.5, 0.25]);
  store.stepTimeline(restored.id, 'redo');
  assert.equal(currentAudio().length, 1);
  store.updateClip(hidden.videoId, { in_point: 0.5 });
  assert.deepEqual(currentAudio().find(clip => clip.id === rightVoice.id), rightVoice);
});

test('a portable backup keeps split clip timing, undone edits and their media across profiles', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'profile'));
  const project = store.createProject('Split export', path.join(root, 'project'), templates[0]);
  const file = path.join(root, 'still.png');
  await fs.writeFile(file, 'still media fixture');
  const [asset, redoAsset] = await store.addMedia(project.id, ['still.png', 'redo.png'].map(name => ({ src: file, name, kind: 'image' })));
  const unusedTrack = store.addTrack(project.id, 'subtitle', 'Discarded');
  const track = store.addTrack(project.id, 'video', 'Video');
  store.deleteTrack(project.id, unusedTrack.id);
  const clip = store.addClip(track.id, { asset_id: asset.id, duration: 3, transition: 'fade' });
  store.splitClip(clip.id, 1.5, 24);
  store.addClip(track.id, { asset_id: redoAsset.id, start: 4, duration: 1 });
  store.stepTimeline(project.id, 'undo');
  const backup = await createBackup(project.id, root);
  const manifest = path.join(backup.directory, manifestName);
  const saved = JSON.parse(await fs.readFile(manifest));
  assert.equal(saved.version, 9);
  await store.init(path.join(root, 'new profile'));
  const { project: restored } = await restoreBackup(manifest, root);
  const tracks = store.project(restored.id).tracks;
  assert.equal(tracks[0].position, track.position);
  assert.deepEqual(tracks[0].clips.map(piece => [piece.start, piece.duration, piece.in_point, piece.split_offset, piece.split_duration]),
    [[0, 1.5, 0, 0, 3], [1.5, 1.5, 0, 1.5, 3]]);
  assert.deepEqual(store.timelineHistory(restored.id, tracks), { undo: '拆分片段', redo: '添加片段' });
  const newRedoAsset = store.assets(restored.id).find(item => item.name === 'redo.png');
  assert.notEqual(newRedoAsset.id, redoAsset.id);
  assert.equal(store.assetCleanupPlan(restored.id).assets.some(item => item.id === newRedoAsset.id), false);
  store.stepTimeline(restored.id, 'redo');
  assert.equal(store.project(restored.id).tracks[0].clips[2].asset_id, newRedoAsset.id);
  store.stepTimeline(restored.id, 'undo');
  assert.deepEqual(store.project(restored.id).tracks, tracks);
  store.stepTimeline(restored.id, 'undo');
  const [whole] = store.project(restored.id).tracks[0].clips;
  assert.deepEqual([whole.id, whole.duration, whole.split_duration], [tracks[0].clips[0].id, 3, null]);
  store.stepTimeline(restored.id, 'redo');
  assert.deepEqual(store.project(restored.id).tracks, tracks);

  const badCursor = { ...saved, timelineHistory: { ...saved.timelineHistory, cursor: 0 } };
  await fs.writeFile(manifest, JSON.stringify(badCursor));
  await assert.rejects(restoreBackup(manifest, root), /时间线撤销与重做记录无效/);
  saved.timelineHistory.entries.at(-1).tracks[0].clips.at(-1).asset_id = 'unknown';
  await fs.writeFile(manifest, JSON.stringify(saved));
  await assert.rejects(restoreBackup(manifest, root), /时间线片段引用无效/);
});

test('a portable backup remaps confirmed and unfinished shot reference images and their task inputs', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'source profile'));
  const project = store.createProject('Cast', path.join(root, 'source project'), templates[0]);
  const source = path.join(root, 'fixture.png');
  await fs.writeFile(source, 'image fixture');
  const [confirmed, draft, editing] = await store.addMedia(project.id, ['Confirmed', 'Draft', 'Editing']
    .map(name => ({ src: source, name, kind: 'image' })));
  const bundle = preset('drama', 'reference-video');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [shot] = store.setShots(project.id, [{ prompt: 'Show the leading character', duration: 1, reference_image_id: confirmed.id }], true);
  const [payload] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
  const job = store.addJob(project.id, 'comfy', payload);
  const [output] = await store.addMedia(project.id, [{ src: source, kind: 'image', origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [output.id] }) });
  const analysis = {
    summary: 'Arrival', characters: ['Lead'], scenes: [], sceneCuts: [{ start: 0, end: 1 }],
    referenceSources: { script: false, frames: 0, transcription: 'partial', transcriptionProgress: { total: 2, missing: [2] } },
    referenceTranscript: 'The ferry leaves at three.',
  };
  const transcriptionCheckpoint = { key: 'f'.repeat(64), segments: [analysis.referenceTranscript, null] };
  store.saveProduction(project.id, { analysis, transcriptionCheckpoint, draftShots: [{ ...shot, reference_image_id: draft.id }] });
  store.saveEditorDraft(project.id, 'shots', [{ ...shot, reference_image_id: editing.id }]);

  const { directory } = await createBackup(project.id, root);
  const file = path.join(directory, manifestName);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.version, 7);
  await store.init(path.join(root, 'target profile'));
  const result = await restoreBackup(file, root);
  const restored = store.project(result.project.id);
  assert.deepEqual(restored.production.analysis, analysis);
  assert.deepEqual(restored.production.transcriptionCheckpoint, transcriptionCheckpoint);
  const refs = new Map(restored.assets.map(asset => [asset.name, asset.id]));
  assert.notEqual(refs.get('Confirmed'), confirmed.id);
  const [restoredShot] = restored.shots;
  assert.equal(restoredShot.reference_image_id, refs.get('Confirmed'));
  assert.equal(restored.production.draftShots[0].reference_image_id, refs.get('Draft'));
  assert.equal(restored.editorDrafts.shots[0].reference_image_id, refs.get('Editing'));
  const detail = JSON.parse(restored.jobs[0].detail);
  assert.equal(detail.shotId, restoredShot.id);
  assert.equal(detail.assetInputs.referenceImage, restoredShot.reference_image_id);
  assert.throws(() => buildGeneration(restored, bundle, services.DEFAULT_COMFY, [restoredShot.id]), /草稿/);
  store.saveProduction(restored.id, { draftShots: null }, 'shots');
  const [request] = buildGeneration(store.project(restored.id), bundle, services.DEFAULT_COMFY, [restoredShot.id]);
  assert.equal(request.assetInputs.referenceImage, refs.get('Confirmed'));

  await fs.writeFile(file, JSON.stringify({ ...saved, version: 6 }));
  await assert.rejects(restoreBackup(file, root), /分镜参考图/);
  await fs.writeFile(file, JSON.stringify({ ...saved, shots: [{ ...shot, status: 'approved', reference_image_id: 'unknown' }] }));
  await assert.rejects(restoreBackup(file, root), /分镜参考图/);
});

test('backup restores retained outputs and the history of a cleaned generation job', async t => {
  const root = await fixtureDirectory(t);
  await store.init(path.join(root, 'source'));
  const project = store.createProject('Cleaned outputs', path.join(root, 'project'), templates[0]);
  const file = path.join(root, 'result.png');
  await fs.writeFile(file, 'generated output');
  const job = store.addJob(project.id, 'comfy', {});
  const [kept, removed] = await store.addMedia(project.id, ['kept', 'removed'].map(name => ({
    src: file, name, kind: 'image', origin: 'comfy', jobId: job.id, outputKey: name,
  })));
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ assets: [kept.id, removed.id] }) });
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: kept.id });
  store.removeUnusedAssets(project.id, [removed.id]);
  const backup = await createBackup(project.id, root);
  await store.init(path.join(root, 'target'));
  const { project: restored } = await restoreBackup(path.join(backup.directory, manifestName), root);
  const current = store.project(restored.id);
  const [asset] = current.assets;
  assert.equal(current.assets.length, 1);
  assert.equal(asset.name, 'kept');
  assert.equal(current.tracks[0].clips[0].asset_id, asset.id);
  assert.deepEqual(JSON.parse(current.jobs[0].detail).assets, [asset.id]);
  assert.equal(JSON.parse(current.jobs[0].detail).removedAssetCount, 1);
});

test('invalid backup versions, missing files and escaping symlinks leave the destination unchanged', async t => {
  const root = await fixtureDirectory(t);
  const origin = path.join(root, 'original profile'), destination = path.join(root, 'restored profile');
  await store.init(origin);
  const project = store.createProject('Backup validation', path.join(root, 'original project'), templates[0]);
  const source = path.join(root, 'input.png');
  await fs.writeFile(source, 'fixture');
  await store.addMedia(project.id, [{ src: source, kind: 'image' }]);
  const { directory } = await createBackup(project.id, root);
  const record = path.join(directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(manifest.version, 1);
  const legacy = await restoreBackup(record, root);
  assert.deepEqual(store.project(legacy.project.id).editorDrafts, {});
  const originalName = manifest.assets[0].file;
  await store.init(destination);
  const initial = (await fs.readdir(root)).sort();

  await fs.writeFile(record, JSON.stringify({ ...manifest, version: 99 }));
  await assert.rejects(restoreBackup(record, root), /版本不受支持/);
  await fs.writeFile(record, JSON.stringify({ ...manifest, version: 2, editorDrafts: { inputs: { referenceVideo: 'unknown' } } }));
  await assert.rejects(restoreBackup(record, root), /输入编辑草稿无效/);
  manifest.assets[0].file = '../../input.png';
  await fs.writeFile(record, JSON.stringify(manifest));
  await assert.rejects(restoreBackup(record, root), /媒体文件名无效/);
  manifest.assets[0].file = originalName;
  await fs.writeFile(record, JSON.stringify(manifest));
  const included = path.join(directory, 'media', originalName);
  await fs.writeFile(included, 'damage!', 'utf8');
  await assert.rejects(restoreBackup(record, root), /素材内容校验失败/);
  await fs.unlink(included);
  await assert.rejects(restoreBackup(record, root), /缺少 media\//);
  if (process.platform !== 'win32') {
    await fs.symlink(source, included);
    await assert.rejects(restoreBackup(record, root), /媒体文件不在备份目录内/);
  }
  assert.deepEqual((await fs.readdir(root)).sort(), initial);
  assert.equal(store.all('SELECT * FROM projects').length, 0);
});
