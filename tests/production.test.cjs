const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const http = require('node:http');
const store = require('../electron/store.cjs');
const assetFiles = require('../electron/asset-file.cjs');
const services = require('../electron/services.cjs');
const media = require('../electron/media.cjs');
const { buildGeneration, templates } = require('../electron/templates.cjs');
const { preset } = require('../electron/presets.cjs');
const { createJobs, createRenderSnapshot } = require('../electron/jobs.cjs');

const ffmpeg = media.resolveFFmpeg();
const ff = (...args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const hasFFmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const makeFolder = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imodureel-production-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function waitForJob(jobId, status) {
  let job;
  for (let count = 0; count < 100; count++) {
    job = store.one('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (job.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(JSON.stringify(job));
}

async function waitForStorageIssue(jobs, jobId) {
  for (let count = 0; count < 200; count++) {
    const issue = jobs.storageIssue(jobId);
    if (issue) return issue;
    await delay(20);
  }
  assert.fail('The task did not report a storage pause: ' + jobId);
}

test('mixed media imports preserve readable files and report probe and copy errors independently', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Mixed imports', path.join(directory, 'project'), templates[0]);
  const image = path.join(directory, '可用图片.png');
  const sound = path.join(directory, '可用音频.wav');
  const bad = path.join(directory, '损坏视频.mp4');
  const cannotCopy = path.join(directory, '不可复制.png');
  ff('-f', 'lavfi', '-i', 'color=lime:s=48x48', '-frames:v', '1', image);
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', sound);
  fs.writeFileSync(bad, 'broken file');
  fs.copyFileSync(image, cannotCopy);
  const copyAssetFile = assetFiles.copyAssetFile;
  t.mock.method(assetFiles, 'copyAssetFile', async (source, output, signal) => {
    if (source !== cannotCopy) return copyAssetFile(source, output, signal);
    fs.writeFileSync(output, 'partly written file');
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  const report = await services.importMedia(project.id, [image, bad, cannotCopy, sound]);
  assert.deepEqual(report.imported.map(asset => asset.kind), ['image', 'audio']);
  assert.deepEqual(report.failed, [
    { name: path.basename(bad), reason: '无法读取或识别媒体格式' },
    { name: path.basename(cannotCopy), reason: '没有读取或写入权限' },
  ]);
  await assert.rejects(store.addMedia(project.id, [
    { src: image, kind: 'image' }, { src: cannotCopy, kind: 'image' },
  ]), /permission denied/);
  await store.init(directory);
  assert.equal(store.assets(project.id).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(project.dir, 'assets')).sort(), report.imported.map(asset => path.basename(asset.path)).sort());
  assert.ok(fs.existsSync(image) && fs.existsSync(sound));
});

test('HEIC and HEIF import the primary image as PNG and relinking the same photo preserves the asset version', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Phone photos', path.join(directory, 'project'), templates[0]);
  const source = path.join(directory, '拍摄照片.HEIC');
  const heif = path.join(directory, 'second.heif');
  const corrupt = path.join(directory, 'broken.heic');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'color-blocks.heic'), source);
  fs.copyFileSync(source, heif);
  fs.writeFileSync(corrupt, 'an incomplete image');
  const { imported, failed } = await services.importMedia(project.id, [source, corrupt, heif]);
  assert.deepEqual(imported.map(item => item.name), ['拍摄照片.HEIC', 'second.heif']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'broken.heic');
  assert.match(failed[0].reason, /HEIC\/HEIF 主图/);
  const [asset, second] = imported;
  assert.equal(asset.kind, 'image');
  assert.equal(path.extname(asset.path), '.png');
  assert.equal(fs.readFileSync(asset.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const { width, height, data } = require('pngjs').PNG.sync.read(fs.readFileSync(asset.path));
  assert.deepEqual([width, height], [96, 64]);
  assert.ok(data[(32 * width + 12) * 4] > 225, 'red area is retained');
  assert.ok(data[(32 * width + 76) * 4 + 2] > 225, 'blue area is retained');
  assert.equal(asset.sha256, second.sha256);

  fs.unlinkSync(asset.path);
  await services.relinkMedia(asset.id, source);
  const relinked = store.assetRecord(asset.id);
  assert.equal(relinked.name, '拍摄照片.HEIC');
  assert.equal(relinked.revision, 0);
  assert.equal(relinked.sha256, asset.sha256);
  const track = store.addTrack(project.id, 'video', 'Photo');
  store.addClip(track.id, { asset_id: asset.id, duration: 1 });
  const generated = await media.exportVideo(store.project(project.id), { preview: true });
  assert.equal(await media.countVideoFrames(generated), 30);
});

test('damaged media is rejected on import or render instead of completing with black frames', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Damaged video', path.join(directory, 'project'), templates[0]);
  const intact = path.join(directory, 'intact.mp4');
  const truncated = path.join(directory, 'truncated.mp4');
  const corrupt = path.join(directory, 'corrupt.mp4');
  const matroska = path.join(directory, 'intact.mkv');
  const truncatedMatroska = path.join(directory, 'truncated.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=24:d=2', '-c:v', 'libx264', '-movflags', '+faststart', intact);
  const bytes = fs.readFileSync(intact);
  const mediaBox = bytes.indexOf('mdat');
  assert.ok(mediaBox > 8);
  fs.writeFileSync(truncated, bytes.subarray(0, Math.trunc(bytes.length * 0.6)));
  bytes.fill(255, mediaBox + 4, mediaBox + 12); // Corrupt NAL sizes without changing container lengths.
  fs.writeFileSync(corrupt, bytes);
  ff('-i', intact, '-c', 'copy', matroska);
  const matroskaBytes = fs.readFileSync(matroska);
  fs.writeFileSync(truncatedMatroska, matroskaBytes.subarray(0, Math.trunc(matroskaBytes.length * 0.6)));

  const report = await services.importMedia(project.id, [truncated, intact]);
  assert.equal(report.imported.length, 1);
  assert.equal(report.failed[0]?.name, 'truncated.mp4');
  assert.match(report.failed[0]?.reason, /媒体文件不完整/);
  const [legacy, badPacket, incompleteMatroska] = await store.addMedia(project.id, [truncated, corrupt, truncatedMatroska].map(src => ({
    src, kind: 'video', duration: 2,
  })));
  const track = store.addTrack(project.id, 'video', 'Video');
  const output = path.join(directory, 'should-not-be-published.mp4');
  const clip = store.addClip(track.id, { asset_id: legacy.id });
  await assert.rejects(media.exportVideo(store.project(project.id), { output }), /媒体文件不完整/);
  store.updateClip(clip.id, { asset_id: badPacket.id });
  await assert.rejects(media.exportVideo(store.project(project.id), { output }), /Invalid|Error|corrupt/i);
  store.updateClip(clip.id, { asset_id: incompleteMatroska.id });
  await assert.rejects(media.exportVideo(store.project(project.id), { output }), /未完整读取/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(output + '.partial.mp4'), false);
});

test('asset cleanup protects editing and job references and resumes after staging files', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Asset cleanup', path.join(directory, 'project'), templates[2]);
  const other = store.createProject('Other reference', path.join(directory, 'other'), templates[0]);
  const input = path.join(directory, 'media.mp4');
  fs.writeFileSync(input, 'source media');
  const add = async (name, options) => (await store.addMedia(project.id, [{ src: input, kind: 'video', duration: 2, name, ...options }]))[0];
  const assets = [];
  for (const name of ['Saved input', 'Input draft', 'Timeline', 'Clip draft', 'Export source', 'Job input', 'Unused', 'Shared']) {
    assets.push(await add(name));
  }
  const [source, inputDraft, clipAsset, clipDraft, snapshotSource, usedByJob, spare, sharedFile] = assets;
  store.saveInputs(project.id, 'enhance', { sourceVideo: source.id });
  store.saveEditorDraft(project.id, 'inputs', { sourceVideo: inputDraft.id });
  const track = store.addTrack(project.id, 'video', 'Video');
  const clip = store.addClip(track.id, { asset_id: clipAsset.id });
  store.saveEditorDraft(project.id, 'clip', { ...clip, asset_id: clipDraft.id });
  const job = store.addJob(project.id, 'export', { snapshot: { dir: project.dir, assets: [snapshotSource], tracks: [] } });
  store.updateJob(job.id, { status: 'done' });
  const consumer = store.addJob(project.id, 'comfy', { assetInputs: { sourceVideo: usedByJob.id } });
  store.updateJob(consumer.id, { status: 'failed' });
  const active = store.addJob(project.id, 'comfy', {});
  const partial = await add('Collecting', { origin: 'comfy', jobId: active.id });
  store.updateJob(active.id, { status: 'collecting' });
  const done = store.addJob(project.id, 'comfy', {});
  const generated = await add('Unused render', { origin: 'comfy', jobId: done.id });
  store.updateJob(done.id, { status: 'done', detail: JSON.stringify({ assets: [generated.id] }) });
  store.approveEnhancement(project.id, generated.id, 0);
  store.saveProduction(project.id, { approvedOutput: generated.id });
  const [alias] = await store.addMedia(other.id, [{ src: input, kind: 'video' }]);
  store.run('UPDATE assets SET path = ? WHERE id = ?', [sharedFile.path, alias.id]);

  const plan = store.assetCleanupPlan(project.id);
  assert.equal(plan.protectedCount, 7);
  assert.deepEqual(plan.assets.map(asset => asset.id), [spare.id, sharedFile.id, generated.id]);
  for (const asset of [source, inputDraft, clipAsset, clipDraft, snapshotSource, usedByJob, partial]) {
    assert.throws(() => store.removeUnusedAssets(project.id, [spare.id, asset.id]), /已被使用/);
  }
  assert.equal(store.pendingAssetTrash(project.id).length, 0);
  assert.deepEqual(store.removeUnusedAssets(project.id, plan.assets.map(asset => asset.id)), { removed: 3, retained: 1 });
  assert.throws(() => store.saveEditorDraft(project.id, 'inputs', { sourceVideo: spare.id }), /素材已移除/);
  assert.equal(fs.existsSync(sharedFile.path), true);
  assert.equal(fs.existsSync(input), true);
  const detail = JSON.parse(store.one('SELECT detail FROM jobs WHERE id = ?', [done.id]).detail);
  assert.deepEqual([detail.assets, detail.removedAssetCount], [[], 1]);
  assert.deepEqual(store.production(project.id).enhancementReviews, {});
  assert.equal(store.production(project.id).approvedOutput, undefined);

  await store.init(directory);
  const staged = store.stageAssetTrash(project.id);
  assert.equal(staged.length, 2);
  assert.ok(staged.every(item => item.staged && fs.existsSync(item.staged) && !fs.existsSync(item.source)));
  await store.init(directory);
  assert.deepEqual(store.stageAssetTrash(project.id), staged);
  for (const item of staged) fs.unlinkSync(item.staged);
  const alreadyGone = store.stageAssetTrash(project.id);
  assert.ok(alreadyGone.every(item => !item.staged && !item.retained));
  store.finishAssetTrash(alreadyGone.map(item => item.id));
  assert.equal(store.assetCleanupPlan(project.id).pendingCount, 0);
});

test('pending asset cleanup survives a moved project and retains a later replacement at the original path', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Moved cleanup', path.join(directory, 'project'), templates[0]);
  const file = path.join(directory, 'source.png');
  fs.writeFileSync(file, 'original version');
  const [first, second] = await store.addMedia(project.id, Array.from({ length: 2 }, () => ({ src: file, kind: 'image' })));
  store.removeUnusedAssets(project.id, [first.id, second.id]);
  const moved = path.join(path.dirname(project.dir), 'moved');
  fs.renameSync(project.dir, moved);
  assert.ok(store.stageAssetTrash(project.id).every(item => /定位已移动的项目目录/.test(item.error)));
  assert.equal(store.pendingAssetTrash(project.id).length, 2);
  const changed = path.join(moved, path.relative(project.dir, second.path));
  fs.writeFileSync(changed, 'replacement');
  await store.relocateProject(project.id, moved);
  const items = store.stageAssetTrash(project.id);
  assert.ok(items[0].staged && fs.existsSync(items[0].staged));
  assert.equal(items[1].retained, true);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'replacement');
});

test('completed previews release unused sources while queued previews and historic exports keep them', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Preview sources', path.join(directory, 'project'), templates[0]);
  const fixture = path.join(directory, 'frame.png');
  fs.writeFileSync(fixture, 'Fixture media');
  const [discarded, queued, exported] = await store.addMedia(project.id,
    ['Discarded', 'Queued', 'Exported'].map(name => ({ src: fixture, kind: 'image', name })));
  const record = (kind, status, asset) => {
    const job = store.addJob(project.id, kind, { snapshot: { assets: [asset], tracks: [] } });
    store.updateJob(job.id, { status });
  };
  record('preview', 'done', discarded);
  record('preview', 'queued', queued);
  record('export', 'done', exported);
  assert.deepEqual(store.assetCleanupPlan(project.id).assets.map(asset => asset.id), [discarded.id]);
  assert.deepEqual(store.removeUnusedAssets(project.id, [discarded.id]), { removed: 1, retained: 0 });
  assert.equal(store.stageAssetTrash(project.id)[0].source, discarded.path);
  assert.equal(fs.existsSync(discarded.path), false);
});

test('approved shots survive a failed replacement and a newer AI draft', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Short', path.join(directory, 'project'), templates[0]);
  assert.throws(() => store.createProject('Other', project.dir, templates[1]), /其他项目/);
  const second = store.createProject('Other', path.join(directory, 'different'), templates[1]);
  store.setShots(project.id, [{ id: 'first', title: 'First', prompt: 'A city', duration: 3 }], true);
  store.setShots(second.id, [{ id: 'belongs-to-another-project', prompt: 'Other city' }], true);
  assert.throws(() => store.setShots(project.id, [{ id: 'second', prompt: 'Park' }, { id: 'belongs-to-another-project', prompt: 'Sea' }], true), /UNIQUE/);
  store.saveProduction(project.id, { analysis: { summary: 'new suggestion' } });
  await store.init(directory);
  const restored = store.project(project.id);
  assert.equal(restored.shots[0].id, 'first');
  assert.equal(restored.shots[0].status, 'approved');
  assert.equal(restored.production.analysis.summary, 'new suggestion');
  const bundle = { workflow: { one: { class_type: 'Example', inputs: { text: '' } } }, mapping: { prompt: { node: 'one', input: 'text' } } };
  assert.throws(() => buildGeneration(restored, bundle, services.DEFAULT_COMFY, ['belongs-to-another-project']), /已确认分镜/);
  const generate = () => buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, ['first']);
  store.saveProduction(project.id, { draftShots: [{ id: 'edit' }] });
  assert.throws(generate, /草稿/);
  store.saveProduction(project.id, { draftShots: null });
  const revised = { ...restored.shots[0], prompt: 'An empty city after sunrise' };
  store.saveEditorDraft(project.id, 'shots', [revised]);
  await store.init(directory);
  assert.throws(generate, /草稿/);
  assert.equal(store.project(project.id).shots[0].prompt, 'A city');
  store.setShots(project.id, [revised], true);
  assert.equal(generate()[0].values.prompt, revised.prompt);
});

test('older projects upgrade without losing approved shots or in-use assets', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Earlier version', path.join(directory, 'project'), { ...templates[0], version: 2 });
  const [shot] = store.setShots(project.id, [{ title: 'Opening', prompt: 'My scene', duration: 2 }], true);
  const fixture = path.join(directory, 'picture.png');
  fs.writeFileSync(fixture, 'Media copy fixture');
  const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'image' }]);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: asset.id, duration: 2 });

  const databaseFile = path.join(directory, 'imodureel.sqlite');
  const SQL = await require('sql.js')();
  const database = new SQL.Database(fs.readFileSync(databaseFile));
  database.run(`ALTER TABLE shots DROP COLUMN scene; ALTER TABLE shots DROP COLUMN characters; ALTER TABLE shots DROP COLUMN reference_image_id;
    ALTER TABLE shots DROP COLUMN dialogue_audio_id;
    ALTER TABLE asset_metadata DROP COLUMN revision; DROP INDEX clips_linked_video;
    ALTER TABLE clips DROP COLUMN linked_video_id;
    ALTER TABLE clips DROP COLUMN dialogue_window`);
  const legacyBytes = Buffer.from(database.export());
  fs.writeFileSync(databaseFile, legacyBytes);
  database.close();

  const open = fs.openSync;
  let diskFull = true;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (diskFull && file === databaseFile + '.tmp') throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return open(file, ...args);
  });
  await store.init(directory);
  assert.deepEqual(fs.readFileSync(databaseFile), legacyBytes);
  const restored = store.project(project.id);
  assert.equal(restored.template_version, 2);
  assert.deepEqual([restored.shots[0].id, restored.shots[0].status, restored.shots[0].characters], [shot.id, 'approved', []]);
  assert.equal(restored.tracks[0].clips[0].asset_id, asset.id);
  assert.equal(restored.tracks[0].clips[0].linked_video_id, null);
  assert.deepEqual([restored.assets[0].revision, restored.assets[0].exists], [0, true]);
  assert.throws(() => store.renameProject(project.id, 'Cannot commit yet'), { code: 'ENOSPC' });
  assert.equal(store.project(project.id).name, project.name);
  assert.deepEqual(fs.readFileSync(databaseFile), legacyBytes);

  diskFull = false;
  store.renameProject(project.id, 'Recovered project');
  const persisted = new SQL.Database(fs.readFileSync(databaseFile));
  assert.ok(persisted.exec('PRAGMA table_info(shots)')[0].values.some(column => column[1] === 'dialogue_audio_id'));
  assert.ok(persisted.exec('PRAGMA table_info(clips)')[0].values.some(column => column[1] === 'dialogue_window'));
  persisted.close();
  await store.init(directory);
  assert.equal(store.project(project.id).name, 'Recovered project');
});

test('relocating a moved project preserves asset IDs, clips and prior render paths', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Move', path.join(directory, 'original'), templates[0]);
  const fixture = path.join(directory, 'poster.png');
  fs.writeFileSync(fixture, 'Existing asset');
  const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'image' }]);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: asset.id });
  const file = path.join(project.dir, 'exports', 'finished.mp4');
  fs.writeFileSync(file, 'Existing render');
  const snapshot = { dir: project.dir, assets: [asset], tracks: store.project(project.id).tracks };
  const job = store.addJob(project.id, 'export', { snapshot });
  const destination = path.join(path.dirname(project.dir), 'moved');
  const empty = path.join(path.dirname(project.dir), 'empty');
  fs.mkdirSync(empty);
  fs.renameSync(project.dir, destination);
  await assert.rejects(store.relocateProject(project.id, destination), /等待项目中的任务结束/);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ file, snapshot }) });
  await assert.rejects(store.relocateProject(project.id, empty), /找不到任何项目素材/);
  const movedFile = path.join(destination, path.relative(project.dir, asset.path));
  fs.writeFileSync(movedFile, 'Unrelated bytes under the same name');
  await assert.rejects(store.relocateProject(project.id, destination), /文件与原素材内容不同.*poster.png/);
  assert.equal(store.project(project.id).dir, project.dir);
  assert.equal(JSON.parse(store.project(project.id).jobs[0].detail).file, file);
  fs.copyFileSync(fixture, movedFile);
  await store.relocateProject(project.id, destination);
  await store.init(directory);
  const relocated = store.project(project.id);
  assert.equal(relocated.dir, destination);
  assert.equal(relocated.assets[0].id, asset.id);
  assert.equal(relocated.assets[0].exists, true);
  assert.equal(relocated.assets[0].sha256, asset.sha256);
  assert.equal(relocated.assets[0].revision, 0);
  assert.equal(relocated.tracks[0].clips[0].asset_id, asset.id);
  const rendered = JSON.parse(relocated.jobs[0].detail);
  assert.equal(rendered.snapshot.dir, destination);
  assert.equal(rendered.snapshot.assets[0].path, relocated.assets[0].path);
  assert.equal(fs.readFileSync(rendered.file, 'utf8'), 'Existing render');
  assert.equal(fs.existsSync(project.dir), false);
});

test('relocation checks historical sources and allows an explicitly confirmed legacy file without a hash', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Historical move', path.join(directory, 'first'), templates[0]);
  const original = path.join(directory, 'original.png');
  const replacement = path.join(directory, 'replacement.png');
  fs.writeFileSync(original, 'Original');
  fs.writeFileSync(replacement, 'Replacement');
  const [asset, legacy] = await store.addMedia(project.id, [original, replacement].map(src => ({ src, kind: 'image' })));
  store.run('UPDATE asset_metadata SET sha256 = NULL WHERE asset_id = ?', [legacy.id]);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: asset.id });
  const { dir, assets, tracks } = store.project(project.id);
  const job = store.addJob(project.id, 'export', { snapshot: { dir, assets: [assets[0]], tracks } });
  store.updateJob(job.id, { status: 'failed' });
  await store.relinkAsset(asset.id, replacement, { kind: 'image' });

  const destination = path.join(directory, 'new project');
  fs.renameSync(project.dir, destination);
  const historical = path.join(destination, path.relative(project.dir, asset.path));
  const legacyFile = path.join(destination, path.relative(project.dir, legacy.path));
  fs.writeFileSync(historical, 'Wrong historical content');
  await assert.rejects(store.relocateProject(project.id, destination), /文件与原素材内容不同.*original.png/);
  fs.copyFileSync(original, historical);
  const { unverified } = await store.relocateProject(project.id, destination);
  assert.deepEqual(unverified, [{ file: path.relative(destination, legacyFile), name: legacy.name, sha256: legacy.sha256 }]);
  assert.equal(store.projectRow(project.id).dir, project.dir);
  fs.writeFileSync(legacyFile, 'Another unverified version');
  const changed = await store.relocateProject(project.id, destination, unverified);
  assert.notDeepEqual(changed.unverified, unverified);
  assert.equal(store.projectRow(project.id).dir, project.dir);
  fs.copyFileSync(replacement, legacyFile);
  await store.relocateProject(project.id, destination, unverified);
  const relocated = store.project(project.id);
  assert.equal(relocated.assets.find(item => item.id === legacy.id).sha256, legacy.sha256);
  assert.equal(JSON.parse(relocated.jobs[0].detail).snapshot.assets[0].path, fs.realpathSync(historical));
});

test('enhancement reviews belong to an asset version and survive recovery and independent approvals', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Enhancement', path.join(directory, 'project'), templates[2]);
  const originals = ['red.mp4', 'green.mp4', 'blue.mp4'].map(name => path.join(directory, name));
  originals.forEach(file => fs.writeFileSync(file, path.basename(file)));
  const [first, second] = await store.addMedia(project.id, originals.slice(0, 2)
    .map(src => ({ src, kind: 'video', duration: 1, origin: 'comfy' })));
  const track = store.addTrack(project.id, 'video', 'Video');
  const add = asset => store.addClip(track.id, { asset_id: asset.id });
  const current = id => store.project(project.id).assets.find(asset => asset.id === id);
  assert.throws(() => add(first), /确认增强结果/);
  store.saveProduction(project.id, { approvedOutput: first.id });
  const firstClip = add(first);
  store.saveProduction(project.id, { approvedOutput: second.id });
  assert.equal(current(first.id).enhancementReviewRequired, false);
  assert.equal(current(second.id).enhancementReviewRequired, false);
  store.approveEnhancement(project.id, second.id, 0);

  const { dir, tracks, assets } = store.project(project.id);
  const job = store.addJob(project.id, 'export', { snapshot: { dir, assets, tracks } });
  store.updateJob(job.id, { status: 'failed' });
  fs.unlinkSync(first.path);
  await store.relinkAsset(first.id, originals[0], { kind: 'video', duration: 1 });
  const original = current(first.id);
  assert.equal(original.revision, 0);
  assert.equal(original.enhancementReviewRequired, false);
  fs.unlinkSync(original.path);
  await store.relinkAsset(first.id, originals[2], { kind: 'video', duration: 1 });
  await store.init(directory);
  assert.equal(current(first.id).enhancementReviewRequired, true);
  assert.equal(current(second.id).enhancementReviewRequired, false);
  assert.equal(store.project(project.id).tracks[0].clips[0].id, firstClip.id);
  assert.throws(() => add(first), /确认增强结果/);
  await assert.rejects(createJobs(() => {}).retry(job.id), /确认增强结果/);
  assert.throws(() => store.approveEnhancement(project.id, first.id, 0), /已更新/);
  store.approveEnhancement(project.id, first.id, 1);
  assert.equal(current(first.id).enhancementReviewRequired, false);
  assert.equal(current(second.id).enhancementReviewRequired, false);
  assert.deepEqual((await createJobs(() => {}).retry(job.id)).replacements, [
    { id: first.id, name: first.name, revision: 1 },
  ]);
  add(first);
  add(second);
});

test('projects can be renamed and archived without losing related data or accepting late writes', async t => {
  const directory = makeFolder(t);
  await store.init(path.join(directory, 'profile'));
  const root = path.join(directory, '项目素材目录');
  const project = store.createProject('原项目名称', root, templates[0]);
  const source = path.join(directory, '素材.png');
  fs.writeFileSync(source, 'surviving source');
  const [asset] = await store.addMedia(project.id, [{ src: source, kind: 'image' }]);
  const track = store.addTrack(project.id, 'video', '画面');
  const clip = store.addClip(track.id, { asset_id: asset.id, duration: 2 });
  const [shot] = store.setShots(project.id, [{ title: '开场', prompt: 'Open the door', duration: 2 }], true);
  store.saveInputs(project.id, 'drama', { script: '初始剧本' });
  const job = store.addJob(project.id, 'comfy', { shotId: shot.id });
  assert.throws(() => store.renameProject(project.id, '  '), /请输入项目名称/);
  store.renameProject(project.id, '  新项目名称  ');
  assert.equal(store.project(project.id).dir, project.dir);
  for (const status of ['queued', 'running', 'disconnected']) {
    store.updateJob(job.id, { status });
    assert.throws(() => store.archiveProject(project.id), /未结束的任务/);
    assert.equal(store.listProjects()[0].name, '新项目名称');
  }
  store.updateJob(job.id, { status: 'cancelled' });

  const copy = assetFiles.copyAssetFile;
  let beginCommit;
  const reachedCopy = new Promise(resolve => { beginCommit = resolve; });
  let continueImport;
  const waitForArchive = new Promise(resolve => { continueImport = resolve; });
  t.mock.method(assetFiles, 'copyAssetFile', async (...args) => {
    const sha256 = await copy(...args);
    beginCommit();
    await waitForArchive;
    return sha256;
  });
  const imported = store.addMedia(project.id, [{ src: source, kind: 'image' }]);
  await reachedCopy;
  try {
    store.archiveProject(project.id);
  } finally {
    continueImport();
  }
  await assert.rejects(imported, /项目已归档/);
  assert.deepEqual(fs.readdirSync(path.dirname(asset.path)), [path.basename(asset.path)]);
  assert.throws(() => store.createProject('重复目录', project.dir, templates[0]), /此目录已用于其他项目/);
  assert.throws(() => store.updateClip(clip.id, { duration: 1 }), /项目已归档/);
  assert.throws(() => store.addJob(project.id, 'comfy', {}), /项目已归档/);
  assert.throws(() => createJobs(() => {}).retry(job.id), /项目已归档/);

  await store.init(path.join(directory, 'profile'));
  assert.deepEqual(store.listProjects(), []);
  const [archived] = store.listProjects(true);
  assert.equal(archived.id, project.id);
  assert.ok(archived.archived_at);
  store.unarchiveProject(project.id);
  store.unarchiveProject(project.id);
  assert.equal(store.listProjects()[0].archived_at, null);
  const restored = store.project(project.id);
  assert.equal(restored.name, '新项目名称');
  assert.equal(restored.dir, project.dir);
  assert.equal(restored.production.inputs.script, '初始剧本');
  assert.deepEqual(restored.shots.map(item => [item.id, item.status]), [[shot.id, 'approved']]);
  assert.deepEqual(restored.jobs.map(item => [item.id, item.status]), [[job.id, 'cancelled']]);
  assert.equal(restored.tracks[0].clips[0].id, clip.id);
  assert.equal(restored.tracks[0].clips[0].duration, 2);
  assert.equal(restored.assets[0].id, asset.id);
  assert.equal(fs.readFileSync(asset.path, 'utf8'), 'surviving source');
});

test('review enforces the selected LTX duration without limiting static workflows', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Drama', path.join(directory, 'project'), templates[0]);
  const shot = { prompt: 'A long scene', duration: 10 };
  const video = preset('drama', 'video');
  store.saveWorkflow(project.id, video.workflow, video.mapping);
  assert.throws(() => store.setShots(project.id, [shot], true), /单镜头时长上限为 8 秒/);
  const still = preset('drama', 'still');
  store.saveWorkflow(project.id, still.workflow, still.mapping);
  assert.equal(store.setShots(project.id, [shot], true)[0].duration, 10);
});

test('ComfyUI preflight checks executable output paths and accepts dynamic custom inputs', async t => {
  const node = (required, output, outputNode = false, extra = {}) =>
    ({ input: { required }, output, output_node: outputNode, python_module: 'nodes', ...extra });
  const info = {
    Source: node({ width: ['INT', { min: 16, max: 1024 }] }, ['IMAGE']),
    Filter: node({ image: ['IMAGE'], strength: ['FLOAT', { min: 0, max: 1 }] }, ['IMAGE']),
    Save: node({ image: ['IMAGE'] }, [], true),
    PreviewImage: node({ image: ['IMAGE'] }, [], true),
    Audio: node({}, ['AUDIO']),
    Custom: node({ group: ['COMFY_AUTOGROW_V3'], input: ['MODEL'], control: ['FLOAT', { min: 0, max: 1 }] },
      ['IMAGE,STRING'], false, { python_module: 'custom_nodes.custom' }),
    LoadImage: node({ image: [['picture.png']] }, ['IMAGE']),
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/object_info') return res.end(JSON.stringify(info));
    if (req.url === '/prompt') return res.writeHead(400).end(JSON.stringify({
      error: { type: 'prompt_outputs_failed_validation' },
      node_errors: { custom: { class_type: 'Custom', errors: [
        { message: 'Custom validation failed', details: 'Expected a motion sketch', extra_info: { input_name: 'control' } },
      ] } },
    }));
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const base = {
    source: { class_type: 'Source', inputs: { width: '1_024' } },
    filter: { class_type: 'Filter', inputs: { image: ['source', 0], strength: '0.5' } },
    save: { class_type: 'Save', inputs: { image: ['filter', 0] } },
    spare: { class_type: 'Source', inputs: {} },
  };
  assert.equal(await services.preflight(url, base, {}), true);
  const cases = [
    [workflow => delete workflow.source.inputs.width, /source\.width.*缺少必填输入/],
    [workflow => { workflow.source.inputs.width = 'abc'; }, /source\.width.*需要有效的 INT 数值/],
    [workflow => { workflow.source.inputs.width = 2048; }, /source\.width.*超出范围/],
    [workflow => { workflow.filter.inputs.image = ['missing', 0]; }, /不存在的节点 missing/],
    [workflow => { workflow.filter.inputs.image = ['source', 2]; }, /不存在的输出口 source\[2\]/],
    [workflow => { workflow.filter.inputs.image = ['source', 0.5]; }, /连线格式不正确/],
    [workflow => { workflow.filter.inputs.image = ['filter', 0]; }, /循环连线/],
    [workflow => { workflow.source = { class_type: 'Audio', inputs: {} }; }, /需要 IMAGE.*输出 AUDIO/],
    [workflow => { workflow.save.class_type = 'PreviewImage'; }, /临时预览输出/],
    [workflow => { delete workflow.save; }, /缺少输出节点/],
  ];
  for (const [change, reason] of cases) {
    const workflow = structuredClone(base);
    change(workflow);
    await assert.rejects(services.preflight(url, workflow, {}), reason);
  }
  const wrongMapping = { title: { node: 'source', input: 'width' } };
  await assert.rejects(services.preflight(url, {
    ...base, save: { class_type: 'Save', inputs: { image: ['loader', 0] } },
    loader: { class_type: 'LoadImage', inputs: { image: 'picture.png [input]' } },
  }, wrongMapping), /映射 title.*未连接到输出节点/);
  const withCustom = {
    ...base,
    custom: { class_type: 'Custom', inputs: { input: ['source', 0], control: 7, untyped: { __value__: [1, 2] } } },
    save: { class_type: 'Save', inputs: { image: ['custom', 0] } },
  };
  assert.equal(await services.preflight(url, withCustom, {}), true);
  assert.equal(await services.preflight(url, {
    loader: { class_type: 'LoadImage', inputs: { image: '' } },
    save: { class_type: 'Save', inputs: { image: ['loader', 0] } },
  }, { productImage: { node: 'loader', input: 'image' } }), true);
  await assert.rejects(services.preflight(url, base, { productImage: { node: 'filter', input: 'image' } }),
    /filter\.image.*需要接收文件名/);
  assert.equal(await services.preflight(url, {
    loader: { class_type: 'LoadImage', inputs: { image: 'picture.png [output]' } },
    save: { class_type: 'Save', inputs: { image: ['loader', 0] } },
  }, {}), true);
  await assert.rejects(services.submitPrepared(url, withCustom), error =>
    error.status === 400 && /custom\.control（Custom）.*Expected a motion sketch/.test(error.message));
});

test('generation preflights resolved parameters before uploading or splitting assets', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const requests = [];
  const enhancement = preset('enhance');
  const info = Object.fromEntries(Object.values(enhancement.workflow).map(node => [node.class_type, { input: {} }]));
  info.UpscaleModelLoader.input.required = { model_name: [['available.pth']] };
  info.Example = { input: { required: { duration: ['FLOAT', { max: 2 }] } } };
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/object_info') return res.end(JSON.stringify(info));
    res.writeHead(422).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const source = path.join(folder, 'fixture');
  fs.writeFileSync(source, 'media bytes');
  const enhanceProject = store.createProject('Enhance', path.join(folder, 'video'), templates[2]);
  const [video] = await store.addMedia(enhanceProject.id, [{ src: source, kind: 'video' }]);
  store.saveInputs(enhanceProject.id, 'enhance', { sourceVideo: video.id });
  const fashionProject = store.createProject('Fashion', path.join(folder, 'fashion'), templates[1]);
  const [picture] = await store.addMedia(fashionProject.id, [{ src: source, kind: 'image' }]);
  store.saveInputs(fashionProject.id, 'fashion', { productImage: picture.id });
  const [shot] = store.setShots(fashionProject.id, [{ prompt: 'A blue coat', duration: 4 }], true);
  const fashion = {
    workflow: { '1': { class_type: 'Example', inputs: { prompt: '', image: '', duration: 0 } } },
    mapping: { prompt: { node: '1', input: 'prompt' }, productImage: { node: '1', input: 'image' },
      duration: { node: '1', input: 'duration' } },
  };
  const probe = t.mock.method(media, 'probe', async () => { throw new Error('Should not probe media'); });
  const split = t.mock.method(media, 'splitEnhancement', async () => { throw new Error('Should not split media'); });
  const jobs = createJobs(() => {});
  const [preview] = jobs.startGeneration(enhanceProject.id, buildGeneration(store.project(enhanceProject.id), enhancement, url, []));
  assert.match(JSON.parse((await waitForJob(preview.id, 'failed')).detail).error, /实例缺少模型.*3\.model_name/);
  const [clip] = jobs.startGeneration(fashionProject.id, buildGeneration(store.project(fashionProject.id), fashion, url, [shot.id]));
  assert.match(JSON.parse((await waitForJob(clip.id, 'failed')).detail).error, /1\.duration.*超出范围/);
  assert.deepEqual(requests, ['/object_info', '/object_info']);
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(split.mock.callCount(), 0);
});

test('built-in video jobs reject entirely black results and retry using external MPS compatibility nodes', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const blackVideo = path.join(folder, 'black.mp4');
  const visibleVideo = path.join(folder, 'visible.mp4');
  ff('-f', 'lavfi', '-i', 'color=black:s=32x32:r=24:d=1', blackVideo);
  ff('-f', 'lavfi', '-i', 'color=black:s=32x32:r=24:d=0.5', '-f', 'lavfi', '-i',
    'color=blue:s=32x32:r=24:d=0.5', '-filter_complex', 'concat=n=2:v=1:a=0', visibleVideo);
  const bundle = preset('drama', 'video');
  const nodes = Object.fromEntries(Object.values(bundle.workflow).map(node => [node.class_type, { input: {} }]));
  const prompts = new Map();
  let device = 'mps';
  let output = blackVideo;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/system_stats') return response.end(JSON.stringify({ devices: [{ type: device }] }));
    if (request.url === '/object_info') return response.end(JSON.stringify(nodes));
    if (request.url === '/prompt') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { prompt, prompt_id } = JSON.parse(Buffer.concat(chunks));
      prompts.set(prompt_id, prompt);
      return response.end(JSON.stringify({ prompt_id }));
    }
    if (request.url.startsWith('/history/')) {
      const id = request.url.split('/').at(-1);
      return response.end(JSON.stringify({ [id]: {
        status: { status_str: 'success', completed: true },
        outputs: { '12': { videos: [{ filename: 'shot.mp4', type: 'output' }] } },
      } }));
    }
    if (request.url.startsWith('/view?')) return response.end(fs.readFileSync(output));
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await store.init(folder);
  const project = store.createProject('External video', path.join(folder, 'project'), templates[0]);
  const [shot] = store.setShots(project.id, [{ title: 'Shot', prompt: 'A clear picture', duration: 2 }], true);
  const target = 'http://127.0.0.1:' + server.address().port;
  const jobs = createJobs(() => {});
  const [initial] = jobs.startGeneration(project.id, buildGeneration(store.project(project.id), bundle, target, [shot.id]));
  const failed = await waitForJob(initial.id, 'failed');
  assert.match(JSON.parse(failed.detail).error, /动态镜头所有帧均为黑色.*MPS 兼容节点/);
  assert.equal(prompts.get(failed.prompt_id)['2'].class_type, 'CLIPLoader');
  assert.equal(store.assets(project.id).length, 0);

  for (const type of ['iModuReelLTXVTextEncoder', 'iModuReelLTXVAttention', 'iModuReelLTXVLatents']) {
    nodes[type] = { input: {} };
  }
  output = visibleVideo;
  const retried = await jobs.retry(failed.id);
  const recovered = await waitForJob(retried.id, 'done');
  const adapted = prompts.get(recovered.prompt_id);
  assert.equal(adapted['2'].class_type, 'iModuReelLTXVTextEncoder');
  assert.deepEqual(adapted['9'].inputs.model, ['14', 0]);
  assert.equal(adapted['3'].inputs.text, shot.prompt);
  assert.equal(store.assets(project.id).filter(asset => asset.job_id === retried.id).length, 1);

  device = 'cuda';
  const [cuda] = jobs.startGeneration(project.id, buildGeneration(store.project(project.id), bundle, target, [shot.id]));
  const completed = await waitForJob(cuda.id, 'done');
  assert.equal(prompts.get(completed.prompt_id)['2'].class_type, 'CLIPLoader');
});

test('ComfyUI jobs bind each confirmed shot, resume by prompt ID, and reject empty output', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const frame = path.join(folder, 'frame.png');
  ff('-f', 'lavfi', '-i', 'color=blue:s=32x32:d=1', '-frames:v', '1', frame);
  const input = fs.readFileSync(frame);
  const seen = new Map();
  let uploads = 0;
  let unavailableHistory = 0;
  let unavailableOutput = false;
  const server = http.createServer(async (req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    const read = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const route = new URL(req.url, 'http://localhost');
    if (route.pathname === '/object_info') return json({ Example: { input: { required: { model: [['available']] } } } });
    if (route.pathname === '/upload/image') {
      assert.ok((await read()).includes(input));
      uploads++;
      return json({ name: 'frame.png', subfolder: 'imodureel/test' });
    }
    if (route.pathname === '/prompt') {
      const result = JSON.parse((await read()).toString());
      seen.set(result.prompt_id, result.prompt.one.inputs);
      return json({ prompt_id: result.prompt_id });
    }
    if (route.pathname.startsWith('/history/')) {
      if (unavailableHistory > 0) {
        unavailableHistory--;
        res.statusCode = 503;
        return json({ error: 'temporarily unavailable' });
      }
      const prompt = route.pathname.split('/').at(-1);
      const text = seen.get(prompt)?.text;
      if (!seen.has(prompt)) return json({});
      if (text === 'engine disk full') return json({ [prompt]: { status: {
        status_str: 'error', messages: [['execution_error', { node_type: 'SaveImage', exception_message: '[Errno 28] No space left on device' }]],
      } } });
      const outputs = text === 'no output' ? {} : { one: {
        images: [{ filename: 'frame.png', type: 'output' }],
        files: [{ filename: 'stats.json', type: 'output' }],
      } };
      return json({ [prompt]: { status: { status_str: 'success', completed: true }, outputs } });
    }
    if (route.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (route.pathname === '/view') {
      if (unavailableOutput) return res.destroy();
      return res.end(route.searchParams.get('filename') === 'stats.json' ? '{"score":1}' : input);
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  await store.init(folder);
  const project = store.createProject('Fashion', path.join(folder, 'project'), templates[1]);
  const [asset] = await store.addMedia(project.id, [{ src: frame, kind: 'image' }]);
  store.saveProduction(project.id, { inputs: { productImage: asset.id } });
  store.setShots(project.id, [
    { id: 'shot-one', title: 'Opening', prompt: 'approved prompt', duration: 1.5, dialogue: 'hello' },
    { id: 'shot-two', title: 'Product', prompt: 'no output', duration: 2 },
  ], true);
  const bundle = {
    workflow: { one: { class_type: 'Example', inputs: { text: '', image: '', duration: 0, dialogue: '', model: 'available' } } },
    mapping: {
      prompt: { node: 'one', input: 'text' }, productImage: { node: 'one', input: 'image' },
      duration: { node: 'one', input: 'duration' }, dialogue: { node: 'one', input: 'dialogue' },
    },
  };
  const payloads = buildGeneration(store.project(project.id), bundle, url, ['shot-two', 'shot-one']);
  const events = [];
  const jobs = createJobs(event => events.push(event));
  const addMedia = store.addMedia;
  let diskFull = true;
  t.mock.method(store, 'addMedia', async (projectId, entries, signal) => {
    if (diskFull && entries.some(entry => entry.origin === 'comfy')) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return addMedia(projectId, entries, signal);
  });
  const [one, two] = jobs.startGeneration(project.id, payloads);
  assert.deepEqual(jobs.queueInfo(project.id).get(two.id), { position: 1, paused: false });
  assert.match((await waitForStorageIssue(jobs, one.id)).message, /磁盘空间不足/);
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [one.id]).status, 'collecting');
  assert.equal(seen.size, 1);
  assert.equal(store.assets(project.id).filter(asset => asset.job_id === one.id).length, 0);
  diskFull = false;
  jobs.resume(one.id);
  await waitForJob(one.id, 'done');
  assert.equal(jobs.storageIssue(one.id), undefined);
  const failed = await waitForJob(two.id, 'failed');
  assert.match(JSON.parse(failed.detail).error, /未返回可用/);
  assert.equal(uploads, 1);
  assert.deepEqual(seen.get(one.id), { text: 'approved prompt', image: 'imodureel/test/frame.png', duration: 1.5, dialogue: 'hello', model: 'available' });
  const [assetFromJob] = store.assets(project.id).filter(item => item.job_id === one.id);
  assert.ok(assetFromJob);
  fs.unlinkSync(assetFromJob.path);
  store.updateJob(one.id, { status: 'running' });
  const restarted = createJobs(event => events.push(event));
  restarted.recover();
  await waitForJob(one.id, 'done');
  assert.equal(seen.size, 2);
  const restored = store.assets(project.id).filter(item => item.job_id === one.id);
  assert.deepEqual(restored.map(item => [item.id, item.exists]), [[assetFromJob.id, true]]);
  unavailableHistory = 2;
  const afterOutage = [];
  const retained = await services.waitPrompt(url, one.id, { poll: 1, onStatus: ({ state }) => afterOutage.push(state) });
  assert.deepEqual(afterOutage, ['reconnecting', 'reconnecting']);
  assert.equal(retained.one.images[0].filename, 'frame.png');
  assert.equal(seen.size, 2, 'Reconnection should not submit another prompt');
  fs.unlinkSync(restored[0].path);
  store.updateJob(one.id, { status: 'collecting' });
  unavailableOutput = true;
  const interrupted = createJobs(event => events.push(event));
  interrupted.recover();
  await waitForJob(one.id, 'disconnected');
  unavailableOutput = false;
  interrupted.resume(one.id);
  await waitForJob(one.id, 'done');
  assert.equal(seen.size, 2, 'Artifact recovery should not submit another prompt');
  assert.equal(store.assets(project.id).find(asset => asset.id === assetFromJob.id).exists, true);
  await assert.rejects(services.waitPrompt(url, 'gone', { poll: 1 }), { code: 'COMFY_PROMPT_MISSING' });
  const failedEngine = jobs.start(project.id, 'comfy', { ...payloads[0], values: { ...payloads[0].values, prompt: 'engine disk full' } });
  const fullEngine = await waitForJob(failedEngine.id, 'failed');
  assert.match(JSON.parse(fullEngine.detail).error, /ComfyUI 所在磁盘的空间不足.*重试生成/);
  assert.equal(jobs.storageIssue(failedEngine.id), undefined);
});

test('a live managed ComfyUI can finish an existing prompt after slow status responses', async t => {
  let now = 0;
  let requests = 0;
  const outputs = { '12': { videos: [{ filename: 'shot.mp4' }] } };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://127.0.0.1:8188/history/shot');
    now += 61000;
    if (++requests <= 3) throw new DOMException('Timed out', 'TimeoutError');
    return Response.json({ shot: { status: { completed: true }, outputs } });
  });
  const wait = isManagedEngineRunning => services.waitPrompt(services.DEFAULT_COMFY, 'shot', {
    poll: 1, isManagedEngineRunning,
  });
  assert.deepEqual(await wait(() => true), outputs);
  assert.equal(requests, 4);
  requests = 0;
  await assert.rejects(wait(() => requests < 2), { code: 'COMFY_DISCONNECTED' });
  assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(wait(), { code: 'COMFY_DISCONNECTED' });
  assert.equal(requests, 2);
});

test('external status polling recovers from gateway timeouts and throttling on the original prompt', async t => {
  const outputs = { '12': { videos: [{ filename: 'shot.mp4' }] } };
  const statuses = [];
  const replies = [];
  let time = 0;
  t.mock.method(Date, 'now', () => time);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, services.DEFAULT_COMFY + '/history/original');
    return replies.shift() ?? Response.json({ original: { status: { completed: true }, outputs } });
  });
  const wait = (advance = 0) => services.waitPrompt(services.DEFAULT_COMFY, 'original', {
    poll: 1,
    onStatus: ({ state }) => { statuses.push(state); time += advance; },
  });
  replies.push(new Response('', { status: 408 }), new Response('', { status: 429 }));
  assert.deepEqual(await wait(), outputs);
  assert.deepEqual(statuses, ['reconnecting', 'reconnecting']);

  replies.push(new Response('', { status: 429 }), new Response('', { status: 429 }));
  await assert.rejects(wait(61000), { code: 'COMFY_DISCONNECTED' });
  assert.deepEqual(await wait(), outputs);
  replies.push(new Response('', { status: 403 }));
  await assert.rejects(wait(), { status: 403 });
});

test('an unreachable ComfyUI pauses later jobs and a missing shared upload is refreshed once', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const project = store.createProject('Queued product shots', path.join(folder, 'project'), templates[1]);
  const fixture = path.join(folder, 'garment.png');
  fs.writeFileSync(fixture, 'Input fixture');
  const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'image' }]);
  store.saveProduction(project.id, { inputs: { productImage: asset.id } });
  const shots = store.setShots(project.id, ['One', 'Two', 'Three'].map(prompt => ({ prompt })), true);
  const bundle = {
    workflow: { image: { class_type: 'LoadImage', inputs: { image: '' } }, text: { class_type: 'Example', inputs: { value: '' } } },
    mapping: { productImage: { node: 'image', input: 'image' }, prompt: { node: 'text', input: 'value' } },
  };
  let reachable = false;
  let uploadCount = 0;
  const submitted = [];
  t.mock.method(services, 'uploadAsset', async () => {
    uploadCount++;
    if (!reachable) throw new TypeError('fetch failed');
    return 'uploaded-' + uploadCount + '.png';
  });
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async (url, prompt) => {
    if (prompt.text.inputs.value === 'Two' && prompt.image.inputs.image === 'uploaded-2.png') {
      throw Object.assign(new Error('missing cached input'), { unavailable: [{ node: 'image', input: 'image' }] });
    }
  });
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    submitted.push([promptId, prompt.image.inputs.image]);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'output' }]);
  const requests = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, shots.map(shot => shot.id));
  const jobs = createJobs(() => {});
  const [first, second, third] = jobs.startGeneration(project.id, requests);
  assert.equal((await waitForJob(first.id, 'disconnected')).prompt_id, null);
  assert.deepEqual(jobs.queueInfo(project.id).get(second.id), { position: 1, paused: true });
  assert.equal(submitted.length, 0);
  reachable = true;
  jobs.resume(first.id);
  await waitForJob(third.id, 'done');
  assert.deepEqual(submitted, [
    [first.id, 'uploaded-2.png'], [second.id, 'uploaded-3.png'], [third.id, 'uploaded-3.png'],
  ]);
  assert.equal(uploadCount, 3);
});

test('stopping a disconnected job saves its remote uncertainty and lets its project retry on a different engine', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Retired engine', path.join(directory, 'project'), templates[0]);
  const other = store.createProject('Keep waiting', path.join(directory, 'other'), templates[0]);
  const originalUrl = 'http://127.0.0.1:46666';
  const newUrl = 'http://127.0.0.1:47777';
  const payload = {
    url: originalUrl, engineDir: path.join(directory, 'old engine'),
    workflow: { '1': { class_type: 'TextNode', inputs: { text: '' } } },
    mapping: { prompt: { node: '1', input: 'text' } }, assetInputs: {}, values: { prompt: 'First shot' },
  };
  const lost = store.addJob(project.id, 'comfy', payload);
  store.updateJob(lost.id, { status: 'disconnected', prompt_id: 'remember-this-prompt' });
  const queued = store.addJob(project.id, 'comfy', { ...payload, values: { prompt: 'Second shot' } });
  const otherLost = store.addJob(other.id, 'comfy', payload);
  store.updateJob(otherLost.id, { status: 'disconnected', prompt_id: 'other-prompt' });
  const otherQueued = store.addJob(other.id, 'comfy', payload);
  const calls = [];
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async url => assert.equal(url, newUrl));
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    assert.equal(url, newUrl);
    calls.push([promptId, prompt['1'].inputs.text]);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'output' }]);
  let scheduler = createJobs(() => {});
  scheduler.recover();
  assert.equal(scheduler.queueInfo(project.id).get(queued.id).paused, true);
  assert.throws(() => store.archiveProject(project.id), /未结束/);
  const stopped = scheduler.stopTracking(lost.id);
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.prompt_id, 'remember-this-prompt');
  assert.match(JSON.parse(stopped.detail).error, /远端任务状态未知/);
  assert.equal(scheduler.queueInfo(project.id).size, 0);
  assert.equal(scheduler.queueInfo(other.id).get(otherQueued.id).paused, true);
  assert.throws(() => scheduler.stopTracking(lost.id), /无法停止跟踪/);
  scheduler.stop();

  await store.init(directory);
  scheduler = createJobs(() => {});
  scheduler.recover();
  assert.equal(scheduler.queueInfo(project.id).size, 0);
  store.archiveProject(project.id);
  store.unarchiveProject(project.id);
  for (const job of [lost, queued]) {
    const retry = scheduler.retry(job.id, { url: newUrl });
    assert.equal(JSON.parse(retry.detail).engineDir, undefined);
    await waitForJob(retry.id, 'done');
  }
  assert.deepEqual(calls.map(([, prompt]) => prompt), ['First shot', 'Second shot']);
  assert.ok(calls.every(([id]) => id !== 'remember-this-prompt'));
  assert.equal(scheduler.queueInfo(other.id).get(otherQueued.id).paused, true);
});

test('a failed generation can use the configured replacement engine without rebuilding the approved snapshot', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const project = store.createProject('Switch engine', path.join(folder, 'project'), templates[0]);
  const originalUrl = 'http://127.0.0.1:46666';
  const localUrl = 'http://127.0.0.1:47777';
  const engineDir = path.join(folder, 'new engine');
  const workflow = { one: { class_type: 'SamplerCustom', inputs: { text: '', noise_seed: 0 } } };
  const mapping = { prompt: { node: 'one', input: 'text' }, seed: { node: 'one', input: 'noise_seed' } };
  const values = { prompt: 'Approved description', seed: 887761 };
  const requested = [];
  const submitted = [];
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async url => {
    requested.push(url);
    if (url === originalUrl) throw new Error('实例缺少节点：SamplerCustom');
  });
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    submitted.push({ url, prompt, promptId });
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'fixture asset' }]);
  const scheduler = createJobs(() => {}, { connectManaged: async directory => {
    assert.equal(directory, engineDir);
    return localUrl;
  } });
  const original = scheduler.start(project.id, 'comfy', { workflow, mapping, values, url: originalUrl, assetInputs: {} });
  const failed = await waitForJob(original.id, 'failed');
  assert.throws(() => scheduler.retry(failed.id, undefined, undefined, true), /请设置此设备的生成引擎/);
  assert.throws(() => scheduler.retry(failed.id, { url: originalUrl }, undefined, true), /当前引擎与原任务一致/);
  store.saveWorkflow(project.id, { new: { class_type: 'Different', inputs: { text: '' } } }, { prompt: { node: 'new', input: 'text' } });

  const same = scheduler.retry(failed.id, { engineDir });
  await waitForJob(same.id, 'failed');
  const switched = scheduler.retry(failed.id, { engineDir }, undefined, true);
  const done = await waitForJob(switched.id, 'done');
  assert.deepEqual(requested, [originalUrl, originalUrl, localUrl]);
  assert.deepEqual(submitted, [{ url: localUrl, promptId: done.prompt_id, prompt: {
    one: { class_type: 'SamplerCustom', inputs: { text: values.prompt, noise_seed: values.seed } },
  } }]);
  assert.equal(JSON.parse(done.detail).engineDir, engineDir);
  const history = store.project(project.id).jobs.find(job => job.id === failed.id);
  assert.equal(history.status, 'failed');
  assert.equal(JSON.parse(history.detail).url, originalUrl);
});

test('legacy job snapshots compact on upgrade and resume with their original workflow and mapping', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Batch upgrade', path.join(directory, 'project'), templates[0]);
  const url = 'http://127.0.0.1:46000';
  const workflow = { '1': { class_type: 'TextNode', inputs: { text: '', alternate: '', description: 'a'.repeat(256 * 1024) } } };
  const mapping = { prompt: { node: '1', input: 'text' } };
  const alternate = { prompt: { node: '1', input: 'alternate' } };
  const legacyIds = Array.from({ length: 10 }, (_, index) => {
    const id = store.id();
    const detail = { workflow, mapping, url, assetInputs: {}, values: { prompt: `saved-shot-${index}` } };
    store.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)', [
      id, project.id, 'comfy', 'queued', null, JSON.stringify(detail), '2026-01-01T00:00:00.000Z',
    ]);
    return id;
  });
  const dbFile = path.join(directory, 'imodureel.sqlite');
  const originalSize = fs.statSync(dbFile).size;
  await store.init(directory);
  assert.ok(fs.statSync(dbFile).size * 4 < originalSize, 'migration should reclaim unused database pages');
  const upgraded = store.project(project.id);
  assert.deepEqual(upgraded.jobs.map(job => job.id), legacyIds.toReversed());
  const details = upgraded.jobs.map(job => JSON.parse(job.detail));
  assert.ok(details.every(detail => !detail.workflow && detail.workflowRef === details[0].workflowRef));
  assert.deepEqual(store.jobWorkflow(details[0].workflowRef), { workflow, mapping });

  const [unchanged, otherBinding] = store.addJobs(project.id, 'comfy', [mapping, alternate].map(mapping => ({
    workflow, mapping, url, assetInputs: {}, values: { prompt: mapping.prompt.input },
  })));
  assert.equal(JSON.parse(unchanged.detail).workflowRef, details[0].workflowRef);
  assert.notEqual(JSON.parse(otherBinding.detail).workflowRef, details[0].workflowRef);
  assert.equal(store.one('SELECT count(*) AS count FROM job_workflows').count, 2);
  store.saveWorkflow(project.id, { '2': { class_type: 'NewNode', inputs: { text: 'new' } } }, {});
  const summary = store.project(project.id, { jobDetails: 'summary', includeWorkflow: false });
  assert.equal(summary.workflow, null);
  assert.ok(summary.jobs.every(job => !('workflowRef' in JSON.parse(job.detail))));
  assert.equal(JSON.parse(summary.jobs.at(-1).detail).values.prompt, 'saved-shot-0');

  await store.init(directory);
  const submitted = [];
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'submitPrepared', async (_, prompt, { promptId }) => {
    const values = prompt['1'].inputs;
    assert.equal(values.description.length, 256 * 1024);
    submitted.push([values.text, values.alternate]);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async () => ({}));
  t.mock.method(services, 'collect', async () => [{ id: 'output' }]);
  createJobs(() => {}).recover();
  await waitForJob(otherBinding.id, 'done');
  assert.deepEqual(submitted, [...legacyIds.map((_, index) => [`saved-shot-${index}`, '']), ['text', ''], ['', 'alternate']]);
});

test('a desktop restart preserves unsent generation jobs and starts the configured local engine again', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const project = store.createProject('Local queue', path.join(folder, 'project'), templates[0]);
  const shots = store.setShots(project.id, ['One', 'Two', 'Cancel me'].map(prompt => ({ prompt })), true);
  const requests = buildGeneration(store.project(project.id), preset('drama', 'still'), undefined, shots.map(shot => shot.id));
  const dir = path.resolve(folder, 'engine');
  let instance;
  const startups = [];
  const submitted = [];
  let signalAborted;
  const released = new Promise(resolve => { signalAborted = resolve; });
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    submitted.push([url, promptId]);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async (url, promptId, { signal }) => {
    if (startups.length > 1) return {};
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      signalAborted();
      reject(signal.reason);
    }, { once: true }));
  });
  t.mock.method(services, 'collect', async () => [{ id: 'output' }]);
  const setup = {
    managedInstance: () => instance,
    connectManaged: async directory => {
      assert.equal(directory, dir);
      const url = 'http://127.0.0.1:' + (8188 + startups.length);
      startups.push(url);
      instance = { url, dir };
      return url;
    },
  };
  const desktop = createJobs(() => {}, setup);
  const [first, second, third] = desktop.startGeneration(project.id, requests.map(request => ({ ...request, engineDir: dir })));
  await waitForJob(first.id, 'queued');
  assert.deepEqual(desktop.queueInfo(project.id).get(second.id), { position: 1, paused: false });
  await desktop.cancel(third.id);
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [third.id]).status, 'cancelled');
  assert.deepEqual(submitted, [[startups[0], first.id]]);
  desktop.stop();
  await released;
  instance = null;
  await store.init(folder);
  const reopened = createJobs(() => {}, setup);
  reopened.recover();
  await waitForJob(second.id, 'done');
  assert.equal((await waitForJob(first.id, 'interrupted')).prompt_id, first.id);
  assert.deepEqual(submitted, [[startups[0], first.id], [startups[1], second.id]]);
});

test('older external ComfyUI jobs recover and cancel by the server-assigned ID after losing submission responses', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const image = path.join(folder, 'frame.png');
  ff('-f', 'lavfi', '-i', 'color=blue:s=32x32:d=1', '-frames:v', '1', image);
  const bytes = fs.readFileSync(image);
  const completed = {};
  const pending = new Map();
  const deleted = [];
  const submissions = [];
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost');
    const json = value => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(value));
    const read = async () => {
      let body = '';
      for await (const chunk of req) body += chunk;
      return JSON.parse(body);
    };
    if (route.pathname === '/object_info') return json({ Example: { input: { required: { text: ['STRING'] } } } });
    if (route.pathname === '/prompt') {
      const { client_id, prompt } = await read();
      const assigned = store.id();
      const item = [submissions.length, assigned, prompt, { client_id }, ['save']];
      submissions.push({ client_id, assigned });
      if (prompt.save.inputs.text === 'Completed') {
        completed[assigned] = { prompt: item, status: { completed: true }, outputs: { save: { images: [{ filename: 'frame.png' }] } } };
      } else if (prompt.save.inputs.text === 'Queued') pending.set(assigned, item);
      return res.writeHead(502).end();
    }
    if (route.pathname === '/history' && route.searchParams.has('max_items')) return json(completed);
    if (route.pathname.startsWith('/history/')) {
      const id = route.pathname.split('/').at(-1);
      return json(completed[id] ? { [id]: completed[id] } : {});
    }
    if (route.pathname === '/queue') {
      if (req.method === 'POST') {
        for (const id of (await read()).delete) {
          deleted.push(id);
          pending.delete(id);
        }
        return res.end();
      }
      return json({ queue_running: [], queue_pending: [...pending.values()] });
    }
    if (route.pathname === '/view' && route.searchParams.get('filename') === 'frame.png') return res.end(bytes);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  await store.init(folder);
  const project = store.createProject('Legacy engine', path.join(folder, 'project'), templates[0]);
  const shots = store.setShots(project.id, ['Completed', 'Queued', 'Unconfirmed'].map(prompt => ({ prompt })), true);
  const bundle = {
    workflow: { save: { class_type: 'Example', inputs: { text: '' } } },
    mapping: { prompt: { node: 'save', input: 'text' } },
  };
  const requests = buildGeneration(store.project(project.id), bundle, url, shots.map(shot => shot.id));
  const first = createJobs(() => {});
  const finished = first.start(project.id, 'comfy', requests[0]);
  assert.equal((await waitForJob(finished.id, 'disconnected')).prompt_id, finished.id);
  first.stop();
  await store.init(folder);
  const reopened = createJobs(() => {});
  t.after(() => reopened.stop());
  reopened.recover();
  reopened.resume(finished.id);
  const done = await waitForJob(finished.id, 'done');
  assert.equal(done.prompt_id, submissions[0].assigned);
  assert.equal(JSON.parse(done.detail).submissionPending, undefined);
  assert.deepEqual(fs.readFileSync(store.assets(project.id)[0].path), bytes);
  assert.equal(submissions.length, 1);

  const queued = reopened.start(project.id, 'comfy', requests[1]);
  await waitForJob(queued.id, 'disconnected');
  const cancelled = await reopened.cancel(queued.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.prompt_id, submissions[1].assigned);
  assert.deepEqual(deleted, [submissions[1].assigned]);
  assert.equal(pending.size, 0);

  const unknown = reopened.start(project.id, 'comfy', requests[2]);
  await waitForJob(unknown.id, 'disconnected');
  await assert.rejects(reopened.cancel(unknown.id), /无法确认.*原任务/);
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [unknown.id]).status, 'disconnected');
  assert.deepEqual(deleted, [submissions[1].assigned]);
  assert.deepEqual(submissions.map(entry => entry.client_id), [finished.id, queued.id, unknown.id]);
});

test('a completed external prompt restores changed local media after restart even when history is cleared', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const frame = path.join(folder, 'frame.png');
  ff('-f', 'lavfi', '-i', 'color=blue:s=32x32:d=1', '-frames:v', '1', frame);
  const bytes = fs.readFileSync(frame);
  const file = { filename: 'frame.png', subfolder: 'approved shot', type: 'output' };
  const outputKey = String(new URLSearchParams(file));
  let submissions = 0;
  let promptId;
  let historyReads = 0;
  let historyAvailable = true;
  let downloadAvailable = false;
  let downloads = 0;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost');
    const json = value => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(value));
    if (route.pathname === '/object_info') return json({ Example: { input: { required: { text: ['STRING'] } } } });
    if (route.pathname === '/prompt') {
      let body = '';
      for await (const chunk of req) body += chunk;
      promptId = JSON.parse(body).prompt_id;
      submissions++;
      return json({ prompt_id: promptId });
    }
    if (route.pathname.startsWith('/history/')) {
      historyReads++;
      if (!historyAvailable) return json({});
      return json({ [promptId]: { status: { completed: true }, outputs: { node: { images: [file] } } } });
    }
    if (route.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (route.pathname === '/view' && String(route.searchParams) === outputKey) {
      downloads++;
      return downloadAvailable ? res.end(bytes) : res.writeHead(503).end();
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  await store.init(folder);
  const project = store.createProject('External recovery', path.join(folder, 'project'), templates[0]);
  const [shot] = store.setShots(project.id, [{ prompt: 'A clock face' }], true);
  const bundle = {
    workflow: { node: { class_type: 'Example', inputs: { text: '' } } },
    mapping: { prompt: { node: 'node', input: 'text' } },
  };
  const [request] = buildGeneration(store.project(project.id), bundle, url, [shot.id]);
  const first = createJobs(() => {});
  const job = first.start(project.id, 'comfy', request);
  const disconnected = await waitForJob(job.id, 'disconnected');
  assert.equal(disconnected.prompt_id, promptId);
  assert.equal(downloads, 1);
  const [registered] = await store.addMedia(project.id, [{ src: frame, kind: 'image', origin: 'comfy', jobId: job.id, outputKey }]);
  fs.writeFileSync(registered.path, 'changed after registration');
  store.updateJob(job.id, { status: 'collecting' });
  first.stop();
  historyAvailable = false;
  downloadAvailable = true;
  const priorReads = historyReads;
  await store.init(folder);
  const reopened = createJobs(() => {});
  reopened.recover();
  const done = await waitForJob(job.id, 'done');
  const [restored, ...others] = store.assets(project.id);
  assert.deepEqual(others, []);
  assert.equal(restored.id, registered.id);
  assert.equal(restored.sha256, registered.sha256);
  assert.deepEqual(fs.readFileSync(restored.path), bytes);
  assert.equal(fs.readFileSync(registered.path, 'utf8'), 'changed after registration');
  assert.deepEqual(JSON.parse(disconnected.detail).outputReceipt, { promptId, files: [file] });
  assert.deepEqual(JSON.parse(done.detail).assets, [registered.id]);
  assert.equal(JSON.parse(done.detail).outputReceipt, undefined);
  assert.equal(historyReads, priorReads);
  assert.equal(downloads, 2);
  assert.equal(submissions, 1);
});

test('a completed local prompt is collected after restart without history or resubmission', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const project = store.createProject('Local outputs', path.join(folder, 'project'), templates[0]);
  const bundle = preset('drama', 'still');
  const dir = path.join(folder, 'engine');
  const initialUrl = 'http://127.0.0.1:8190';
  const nextUrl = 'http://127.0.0.1:8191';
  const [shot] = store.setShots(project.id, [{ prompt: 'A clock face' }], true);
  const [request] = buildGeneration(store.project(project.id), bundle, initialUrl, [shot.id]);
  const interrupted = store.addJob(project.id, 'comfy', { ...request, engineDir: dir });
  store.updateJob(interrupted.id, { prompt_id: interrupted.id, status: 'running' });
  const records = path.join(dir, '.completed-prompts');
  fs.mkdirSync(records, { recursive: true });
  const receipt = path.join(records, interrupted.id + '.json');
  const subfolder = `.imodureel-jobs/${interrupted.id}/${interrupted.id}/shots`;
  const output = path.join(dir, 'ComfyUI', 'output', subfolder, 'clock.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'The engine wrote this before the app closed.');
  fs.writeFileSync(receipt, JSON.stringify([{ filename: 'clock.png', subfolder, type: 'output' }]));

  const registered = store.addJob(project.id, 'comfy', { ...request, engineDir: dir });
  const fixture = path.join(folder, 'clock.png');
  fs.writeFileSync(fixture, 'The asset registration already finished before shutdown.');
  const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'image', jobId: registered.id, origin: 'comfy' }]);
  store.updateJob(registered.id, { prompt_id: registered.id, status: 'collecting' });
  const registeredReceipt = path.join(records, registered.id + '.json');
  fs.copyFileSync(receipt, registeredReceipt);

  let instance;
  let started = 0;
  let collections = 0;
  t.mock.method(services, 'waitPrompt', () => assert.fail('The old engine history is gone'));
  t.mock.method(services, 'submitPrepared', () => assert.fail('Recovery must not submit the completed prompt again'));
  t.mock.method(services, 'collect', async (url, outputs, projectId, options) => {
    assert.equal(url, nextUrl);
    assert.equal(projectId, project.id);
    assert.equal(options.jobId, interrupted.id);
    const [key] = services.outputRecords(outputs).keys();
    assert.equal(new URLSearchParams(key).get('subfolder'), subfolder);
    assert.ok(fs.existsSync(output));
    collections++;
    return store.addMedia(projectId, [{ src: fixture, kind: 'image', jobId: options.jobId, origin: 'comfy' }], options.signal);
  });
  await store.init(folder);
  let diskFull = true;
  const updateJob = store.updateJob;
  t.mock.method(store, 'updateJob', (jobId, fields) => {
    if (diskFull && jobId === registered.id && fields.status === 'done') {
      throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    }
    return updateJob(jobId, fields);
  });
  const desktop = createJobs(() => {}, {
    managedInstance: () => instance,
    connectManaged: async engineDir => {
      assert.equal(engineDir, dir);
      instance = { url: nextUrl, dir };
      started++;
      return nextUrl;
    },
  });
  desktop.recover();
  assert.equal((await waitForStorageIssue(desktop, registered.id)).canCancel, false);
  assert.equal(fs.existsSync(registeredReceipt), true);
  diskFull = false;
  desktop.resume(registered.id);
  const reopened = await waitForJob(interrupted.id, 'done');
  assert.equal(reopened.prompt_id, interrupted.id);
  assert.equal(started, 1);
  assert.equal(collections, 1);
  assert.deepEqual(JSON.parse((await waitForJob(registered.id, 'done')).detail).assets, [asset.id]);
  assert.equal(store.assets(project.id).length, 2);
  const matching = store.assets(project.id).filter(entry => entry.job_id === interrupted.id);
  assert.deepEqual(JSON.parse(reopened.detail).assets, matching.map(entry => entry.id));
  assert.equal(matching.length, 1);
  for (let count = 0; count < 100 && fs.existsSync(output); count++) await delay(20);
  assert.equal(fs.existsSync(output), false);
  assert.ok(fs.existsSync(matching[0].path));
});

test('managed media cleanup preserves shared uploads until the final confirmed cancellation', async t => {
  const folder = makeFolder(t);
  await store.init(folder);
  const project = store.createProject('Managed scratch', path.join(folder, 'project'), templates[1]);
  const dir = path.join(folder, 'engine');
  const input = path.join(dir, 'ComfyUI', 'input');
  const output = path.join(dir, 'ComfyUI', 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const untouched = path.join(output, 'existing.png');
  const otherPrompt = path.join(output, '.imodureel-jobs', store.id(), 'existing.png');
  fs.mkdirSync(path.dirname(otherPrompt), { recursive: true });
  fs.writeFileSync(untouched, 'user file');
  fs.writeFileSync(otherPrompt, 'another project or profile');
  const original = path.join(folder, 'product.png');
  fs.writeFileSync(original, 'original image');
  const [asset] = await store.addMedia(project.id, [{ src: original, kind: 'image' }]);
  store.saveInputs(project.id, 'fashion', { productImage: asset.id });
  const shots = store.setShots(project.id, [{ prompt: 'One' }, { prompt: 'Two' }], true);
  const bundle = preset('fashion', 'still');
  const requests = buildGeneration(store.project(project.id), bundle, undefined, shots.map(shot => shot.id));
  let uploaded;
  const submissions = new Map();
  const { promise: stopRequested, resolve: onStopRequest } = Promise.withResolvers();
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers();
  const url = 'http://127.0.0.1:8188';
  t.mock.method(services, 'preflight', async () => true);
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'uploadAsset', async (_, asset, tag) => {
    assert.equal(uploaded, undefined);
    assert.match(tag, /^imodureel-job-/);
    uploaded = tag + '-product.png';
    fs.copyFileSync(asset.path, path.join(input, uploaded));
    return uploaded;
  });
  t.mock.method(services, 'submitPrepared', async (_, prompt, { promptId, keepOutputs }) => {
    assert.equal(keepOutputs, true);
    assert.equal(prompt['4'].inputs.image, uploaded);
    const prefix = prompt['8'].inputs.filename_prefix;
    assert.equal(prefix, `.imodureel-jobs/${promptId}/${promptId}/iModuReel/shot`);
    const file = path.join(output, prefix + '_00001_.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'generated image');
    submissions.set(promptId, file);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async (_, promptId, { signal }) => {
    if (submissions.size === 1) return { file: submissions.get(promptId) };
    await delay(60000, undefined, { signal });
  });
  t.mock.method(services, 'collect', (_, result, projectId, options) => store.addMedia(projectId,
    [{ src: result.file, kind: 'image', origin: 'comfy', jobId: options.jobId }], options.signal));
  t.mock.method(services, 'cancelPrompt', async (_, promptId, options) => {
    assert.equal(options.waitForStop, true);
    onStopRequest(promptId);
    await stopped;
    return true;
  });

  const desktop = createJobs(() => {}, { managedInstance: () => ({ url, dir }), connectManaged: async () => url });
  const [first, second] = desktop.startGeneration(project.id, requests.map(request => ({ ...request, engineDir: dir })));
  for (let count = 0; count < 100 && !submissions.has(second.id); count++) await delay(20);
  assert.ok(submissions.has(second.id));
  assert.equal(fs.existsSync(submissions.get(first.id)), false);
  assert.ok(fs.existsSync(path.join(input, uploaded)));
  const cancel = desktop.cancel(second.id);
  assert.equal(await stopRequested, second.id);
  assert.ok(fs.existsSync(submissions.get(second.id)));
  assert.ok(fs.existsSync(path.join(input, uploaded)));
  onStopped();
  await cancel;
  assert.equal(fs.existsSync(submissions.get(second.id)), false);
  assert.equal(fs.existsSync(path.join(input, uploaded)), false);
  assert.ok(fs.existsSync(untouched) && fs.existsSync(otherPrompt) && fs.existsSync(original));
  const generated = store.assets(project.id).find(entry => entry.job_id === first.id);
  assert.equal(fs.readFileSync(generated.path, 'utf8'), 'generated image');
  assert.equal(bundle.workflow['8'].inputs.filename_prefix, 'iModuReel/shot');

  const leftover = path.join(output, '.imodureel-jobs', first.id, first.id, 'leftover.png');
  fs.mkdirSync(path.dirname(leftover), { recursive: true });
  fs.writeFileSync(leftover, 'A restart interrupted cleanup, after registration.');
  desktop.recover();
  for (let count = 0; count < 100 && fs.existsSync(leftover); count++) await delay(20);
  assert.equal(fs.existsSync(leftover), false);
  assert.ok(fs.existsSync(generated.path) && fs.existsSync(otherPrompt));
});

test('batched enhancement recovers the current prompt and repairs only missing or damaged segments', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const source = path.join(folder, 'recording.mp4');
  const colors = ['red', 'lime', 'blue', 'yellow'];
  ff(...colors.flatMap(color => ['-f', 'lavfi', '-i', `color=${color}:s=96x64:r=10:d=0.4`]),
    '-f', 'lavfi', '-i', 'sine=550:d=1.6', '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[pictures]',
    '-map', '[pictures]', '-map', '4:a', '-c:v', 'libx264', '-c:a', 'aac', source);
  const uploads = new Map();
  const submitted = new Map();
  const downloads = [];
  const rebuilt = [];
  let disconnect = true;
  assert.equal(media.enhancementBatchSize({ width: 1920, height: 1080, fps: 30, duration: 1 }), 2);
  t.mock.method(media, 'enhancementBatchSize', () => 4);
  const rebuild = media.rebuildEnhancementSegment;
  t.mock.method(media, 'rebuildEnhancementSegment', async (input, output, details, signal) => {
    rebuilt.push([details.firstFrame, details.frames]);
    return rebuild(input, output, details, signal);
  });
  t.mock.method(services, 'uploadAsset', async (url, asset) => {
    const name = path.basename(asset.path);
    uploads.set(name, await fs.promises.readFile(asset.path));
    return name;
  });
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    submitted.set(promptId, prompt['1'].inputs.file);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async (url, promptId) => ({
    '6': { videos: [{ filename: submitted.get(promptId), type: 'output' }] },
  }));
  t.mock.method(services, 'downloadOutput', async (url, key, file) => {
    const name = new URLSearchParams(key).get('filename');
    downloads.push(name);
    if (name === 'source-000002.mp4' && disconnect) {
      const error = new Error('temporary outage');
      error.code = 'COMFY_DISCONNECTED';
      throw error;
    }
    await fs.promises.writeFile(file, uploads.get(name));
  });

  await store.init(folder);
  const project = store.createProject('Batched enhancement', path.join(folder, 'project'), templates[2]);
  const [input] = await store.addMedia(project.id, [{ src: source, ...await media.probe(source) }]);
  store.saveInputs(project.id, 'enhance', { sourceVideo: input.id });
  const [request] = buildGeneration(store.project(project.id), preset('enhance'), services.DEFAULT_COMFY, []);
  const previous = createJobs(() => {});
  const job = previous.start(project.id, 'comfy', request);
  const partial = await waitForJob(job.id, 'disconnected');
  assert.equal(submitted.size, 3);
  assert.ok(submitted.has(partial.prompt_id));
  assert.equal(JSON.parse(partial.detail).enhancement.index, 2);
  assert.equal(store.assets(project.id).length, 1);
  const batch = path.join(project.dir, '.enhancement', job.id);
  const damaged = path.join(batch, 'enhanced-000000.mp4');
  // A different, decodable file with the expected frame count still fails the original checksum.
  ff('-f', 'lavfi', '-i', 'color=black:s=96x64:r=10:d=0.4', '-c:v', 'libx264', damaged);
  assert.equal(await media.countVideoFrames(damaged), 4);
  fs.writeFileSync(path.join(batch, 'source-000000.mp4'), 'corrupt temporary input');
  fs.unlinkSync(path.join(batch, 'source-000003.mp4'));
  // A legacy completed segment with no checksum stays usable.
  fs.unlinkSync(path.join(batch, 'enhanced-000001.mp4.sha256'));

  await store.init(folder);
  disconnect = false;
  const reopened = createJobs(() => {});
  reopened.resume(job.id);
  const completed = await waitForJob(job.id, 'done');
  assert.deepEqual([...submitted.values()], [
    'source-000000.mp4', 'source-000001.mp4', 'source-000002.mp4', 'source-000000.mp4', 'source-000003.mp4',
  ]);
  assert.deepEqual(downloads.slice(3), ['source-000002.mp4', 'source-000000.mp4', 'source-000003.mp4']);
  assert.deepEqual(rebuilt, [[0, 4], [12, 4]]);
  const [assetId] = JSON.parse(completed.detail).assets;
  const result = store.inputAsset(project.id, assetId, ['video']);
  const output = await media.probe(result.path);
  assert.equal(output.audio, true);
  assert.equal(output.duration, 1.6);
  assert.equal(await media.countVideoFrames(result.path), 16);
  const pixels = ff('-i', result.path, '-vf', 'format=rgb24,crop=1:1:2:2', '-f', 'rawvideo', '-');
  const firstPixel = index => [...pixels.subarray(index * 12, index * 12 + 3)].map(value => value > 128);
  assert.deepEqual(colors.map((_, index) => firstPixel(index)), [
    [true, false, false], [false, true, false], [false, false, true], [true, true, false],
  ]);
  assert.equal(fs.existsSync(path.join(project.dir, '.enhancement', job.id)), false);
});

test('built-in enhancement retains picture and sound timing on short and variable-rate sources', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const variable = path.join(folder, 'variable.mp4');
  const delayedPicture = path.join(folder, 'delayed-picture.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=10:d=2',
    '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=700:sample_rate=48000:duration=1',
    '-vf', "drawbox=c=blue:t=fill:enable='gte(t,1)',select='gte(t,1)+not(mod(n,2))'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-c:a', 'aac', variable);
  ff('-itsoffset', '0.4', '-f', 'lavfi', '-i', 'testsrc=s=95x63:r=10:d=1',
    '-f', 'lavfi', '-i', 'sine=700:sample_rate=48000:duration=1.6',
    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', delayedPicture);
  const pictureOnly = new Map();
  const submitted = new Map();
  t.mock.method(services, 'uploadAsset', async (url, asset, id) => {
    assert.equal((await media.probe(asset.path)).audio, false);
    pictureOnly.set(id, asset.path);
    return id;
  });
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    submitted.set(promptId, prompt['1'].inputs.file);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async (url, promptId) => ({
    '6': { videos: [{ filename: submitted.get(promptId) + '.mp4', type: 'output' }] },
  }));
  t.mock.method(services, 'downloadOutput', async (url, key, file) => {
    const id = path.parse(new URLSearchParams(key).get('filename')).name;
    await fs.promises.copyFile(pictureOnly.get(id), file);
  });
  await store.init(folder);
  const project = store.createProject('Enhancement timing', path.join(folder, 'project'), templates[2]);
  const jobs = createJobs(() => {});
  const generate = async input => {
    const [asset] = await store.addMedia(project.id, [{ src: input, ...await media.probe(input) }]);
    store.saveInputs(project.id, 'enhance', { sourceVideo: asset.id });
    const [request] = buildGeneration(store.project(project.id), preset('enhance'), services.DEFAULT_COMFY, []);
    const job = await waitForJob(jobs.start(project.id, 'comfy', request).id, 'done');
    const { enhancement, assets } = JSON.parse(job.detail);
    assert.equal(enhancement.segments.length, 1);
    return store.inputAsset(project.id, assets[0], ['video']).path;
  };

  const conformed = await generate(variable);
  assert.equal(await media.countVideoFrames(variable), 15);
  assert.equal(await media.countVideoFrames(conformed), 20);
  const colorAt = time => ff('-ss', String(time), '-i', conformed, '-frames:v', '1',
    '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-');
  assert.ok(colorAt(0.9)[0] > 200, 'picture before the original cut should be red');
  assert.ok(colorAt(1.1)[2] > 200, 'picture after the original cut should be blue');
  const soundStart = file => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-copyts', '-start_at_zero', '-i', file, '-vn',
      '-af', 'aresample=48000:async=1:first_pts=0,silencedetect=noise=-37dB:d=0.08', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stderr.match(/silence_end: ([\d.]+)/)?.[1]);
  };
  assert.ok(Math.abs(soundStart(variable) - soundStart(conformed)) < 0.02);

  const delayed = await generate(delayedPicture);
  assert.equal(await media.enhancementVideoStart(delayed), 0.4);
  assert.deepEqual(await media.probe(delayed).then(({ audio, duration, width, height }) => ({ audio, duration, width, height })),
    { audio: true, duration: 1.6, width: 95, height: 63 });
  assert.equal(await media.countVideoFrames(delayed), 10);
});

test('enhancement restores display proportions after ComfyUI drops non-square pixel metadata', { skip: !hasFFmpeg }, async t => {
  const folder = makeFolder(t);
  const original = path.join(folder, 'original.mp4');
  const rotated = path.join(folder, 'rotated.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=24:d=0.25', '-f', 'lavfi', '-i', 'sine=440:duration=0.25',
    '-vf', 'setsar=4/3', '-c:v', 'libx264', '-c:a', 'aac', original);
  ff('-display_rotation:v:0', '90', '-i', original, '-map', '0', '-c', 'copy', rotated);
  const decodedFirst = file => ff('-i', file, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-');

  for (const [input, width, height, ratio] of [[original, 384, 256, [4, 3]], [rotated, 256, 384, [3, 4]]]) {
    const directory = path.join(folder, path.basename(input, '.mp4'));
    const source = await media.probe(input);
    const split = await media.splitEnhancement(input, directory, { ...source, batchSize: 3 });
    assert.equal(split.length, 2);
    const enhanced = split.map(segment => {
      const file = segment.file.replace('source-', 'enhanced-');
      ff('-i', path.join(directory, segment.file), '-vf', 'scale=iw*4:ih*4,setsar=1', '-c:v', 'libx264', path.join(directory, file));
      return { ...segment, file };
    });
    const output = path.join(directory, 'joined.mp4');
    await media.joinEnhancement(input, directory, enhanced, { fps: 24, sourceDuration: source.duration }, output);
    const result = await media.probe(output);
    assert.deepEqual([result.width, result.height, result.rotation, result.audio], [width, height, 0, true]);
    assert.deepEqual(result.sampleAspectRatio, ratio);
    assert.equal(await media.countVideoFrames(output), 6);
    assert.deepEqual(decodedFirst(output), decodedFirst(path.join(directory, enhanced[0].file)));

    const bitstream = path.join(directory, 'joined.h264');
    ff('-i', output, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', bitstream);
    assert.deepEqual((await media.probe(bitstream)).sampleAspectRatio, ratio);
  }
});

test('render offsets timing, retains a silent canvas, and burns subtitles', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const source = path.join(directory, 'source.mp4');
  ff('-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', source);
  const video = { asset_id: 'video', start: 1, in_point: 0, duration: 2, volume: 1 };
  const project = {
    dir: directory, assets: [{ id: 'video', kind: 'video', path: source }],
    tracks: [{ kind: 'video', clips: [video] }],
  };
  const result = await media.exportVideo(project, { preview: true });
  const rgb = (time, filename = result) => [...ff('-ss', String(time), '-i', filename, '-frames:v', '1',
    '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-')];
  assert.ok(rgb(0.5).every(channel => channel < 5));
  assert.ok(rgb(1.25)[0] > 240);
  assert.ok(rgb(2.25)[2] > 240);
  const caption = { asset_id: null, start: 0, in_point: 0, duration: 1, volume: 1, text: "第一场｜Hello, world's 100%" };
  const subtitles = await media.exportVideo({ ...project, tracks: [{ kind: 'subtitle', clips: [caption] }] }, { preview: true });
  assert.equal((await media.probe(subtitles)).audio, true);
  const pixels = ff('-i', subtitles, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-');
  assert.ok(pixels.some(channel => channel > 180), 'high-contrast subtitle pixels should be rendered');
});

test('overlapping subtitle clips render on separate rows for the duration of their overlap', { skip: !hasFFmpeg }, async t => {
  const dir = makeFolder(t);
  const clip = { in_point: 0, volume: 1, transition: 'none' };
  const tracks = [
    { kind: 'subtitle', clips: [{ ...clip, start: 0, duration: 0.65, text: 'AAAAAAAA' }] },
    { kind: 'subtitle', clips: [{ ...clip, start: 0.30, duration: 0.65, text: 'WWWWWWWW' }] },
  ];
  for (const preview of [true, false]) {
    const rendered = await media.exportVideo({ dir, assets: [], tracks }, { preview, format: 'landscape' });
    const width = preview ? 640 : 1280;
    function lineCount(time) {
      const frame = ff('-ss', String(time), '-i', rendered, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-');
      const ink = new Set();
      for (let index = 0; index < frame.length; index++) if (frame[index] > 190) ink.add(Math.floor(index / width));
      return [...ink].filter(row => !ink.has(row - 1)).length;
    }
    assert.deepEqual([lineCount(0.13), lineCount(0.43), lineCount(0.73)], [1, 2, 1]);
  }
});

test('preview and final render use identical subtitle pagination', { skip: !hasFFmpeg }, async t => {
  const dir = makeFolder(t);
  const clip = { start: 0, in_point: 0, duration: 0.04, volume: 1, text: '田'.repeat(104) };
  const project = { dir, assets: [], tracks: [{ kind: 'subtitle', clips: [clip] }] };
  for (const preview of [true, false]) {
    const file = await media.exportVideo(project, { preview, format: 'portrait', fps: 24 });
    assert.equal(await media.countVideoFrames(file), 1);
    const frame = ff('-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-');
    assert.ok(frame.some(pixel => pixel > 180));
  }
});

test('HDR video uses the same SDR colors for preview, export, proxies and enhancement inputs', { skip: !hasFFmpeg }, async t => {
  const dir = makeFolder(t);
  function hdrFixture(id, curve, levels, matrix) {
    const [low, mid, high] = levels;
    const file = path.join(dir, id + '.mp4');
    ff('-f', 'lavfi', '-i', `color=gray:s=192x108:r=24:d=1,format=yuv420p10le,geq=lum='if(lt(X,W/3),${low},if(lt(X,2*W/3),${mid},${high}))':cb=512:cr=512`,
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-color_range', 'tv',
      '-colorspace', matrix, '-color_primaries', 'bt2020', '-color_trc', curve, file);
    return { id, path: file, kind: 'video' };
  }
  const pq = hdrFixture('pq', 'smpte2084', [327, 509, 723], 'bt2020nc');
  const hlg = hdrFixture('hlg', 'arib-std-b67', [283, 502, 800], 'unknown');
  const sdr = { id: 'sdr', path: path.join(dir, 'red.mp4'), kind: 'video' };
  ff('-f', 'lavfi', '-i', 'color=red:s=192x108:r=24:d=1', '-c:v', 'libx264', sdr.path);
  const alpha = { id: 'alpha', path: path.join(dir, 'blue.png'), kind: 'image' };
  ff('-f', 'lavfi', '-i', 'color=blue@0.5:s=192x108,format=rgba', '-frames:v', '1', alpha.path);
  const clip = (asset, start, duration) => ({ asset_id: asset.id, start, duration, in_point: 0, volume: 1 });
  // The first render window only contains SDR material. The final mux must
  // retain a single set of color tags and correct colors across its joins.
  const project = { dir, assets: [sdr, pq, hlg, alpha], tracks: [
    { kind: 'video', clips: [...Array.from({ length: 18 }, (_, index) => clip(sdr, index / 8, 1 / 8)),
      clip(pq, 2.25, 0.75), clip(hlg, 3, 0.75)] },
    { kind: 'video', clips: [clip(alpha, 2.6, 0.15)] },
    { kind: 'subtitle', clips: [{ start: 2.8, duration: 0.2, text: 'HDR 与 SDR', in_point: 0, volume: 1 }] },
  ] };
  const headings = file => spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  const luma = (file, at) => {
    const data = ff(...(at === undefined ? [] : ['-ss', String(at)]), '-i', file, '-frames:v', '1',
      '-vf', 'scale=192:108,format=yuv420p', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-');
    assert.equal(data.length, 192 * 108 * 1.5);
    return [32, 96, 160].map(x => data[192 * 54 + x]);
  };
  const rgb = (file, at) => [...ff('-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'format=rgb24,crop=1:1:iw/2:ih/2', '-f', 'rawvideo', '-')];
  function near(actual, expected, tolerance, label) {
    for (const [index, value] of actual.entries()) {
      assert.ok(Math.abs(value - expected[index]) <= tolerance, `${label}: ${actual} vs ${expected}`);
    }
  }
  const exports = [];
  for (const preview of [true, false]) {
    const file = await media.exportVideo(project, { preview, fps: 24, output: path.join(dir, `mix-${preview}.mp4`) });
    assert.match(headings(file), /yuv420p\(tv, bt709/);
    near(rgb(file, 0.5), [255, 0, 0], 10, 'SDR red after color-space conversion');
    const [red, , blue] = rgb(file, 2.67);
    assert.ok(blue > red + 30, 'alpha overlay survived');
    exports.push(file);
  }
  for (const [asset, start, expected, convertedPhoto] of [
    [pq, 2.4, [73, 151, 235], [64, 147, 235]], [hlg, 3.2, [72, 123, 204], [62, 116, 202]],
  ]) {
    const info = await media.probe(asset.path);
    assert.equal(info.color.hdr, true);
    const original = luma(asset.path, 0);
    assert.ok(original.some((value, index) => Math.abs(value - expected[index]) >= (asset === pq ? 10 : 2)));
    for (const file of exports) near(luma(file, start), expected, 4, asset.id + ' timeline');
    const proxy = path.join(dir, asset.id + '-proxy.mp4');
    await media.createProxy(asset, proxy, undefined, info);
    assert.match(headings(proxy), /yuv420p\(tv, bt709/);
    near(luma(proxy), expected, 4, asset.id + ' proxy');
    const photo = path.join(dir, asset.id + '-frame.jpg');
    assert.ok(await media.extractFrame(asset.path, 0.2, photo, undefined, info) >= 0.2);
    near(luma(photo), convertedPhoto, 5, asset.id + ' analysis frame');
    const split = path.join(dir, asset.id + '-split');
    const segments = await media.splitEnhancement(asset.path, split, { ...info, batchSize: 12 });
    assert.deepEqual(segments.map(segment => segment.frames), [12, 12]);
    for (const segment of segments) {
      const pathToSegment = path.join(split, segment.file);
      assert.match(headings(pathToSegment), /yuv420p\(tv, bt709/);
      near(luma(pathToSegment), expected, 4, asset.id + ' enhancement input');
    }
  }
});

test('reference video analysis sends cut time codes and audio instead of the video file', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const movie = path.join(directory, 'reference.mp4');
  ff('-f', 'lavfi', '-i', 'color=black:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'color=white:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=440:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', movie);
  const received = {};
  let transcriptionStatus = 200;
  let transcriptionError;
  let transcriptionBody;
  let transcript = 'Example dialogue';
  let audioRequests = 0;
  let schemaAvailable = true;
  let jsonModeAvailable = true;
  const formats = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    received[req.url] = body;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/audio/transcriptions') {
      audioRequests++;
      const result = transcriptionError ? { error: transcriptionError } : { text: transcript };
      res.writeHead(transcriptionStatus).end(transcriptionBody ?? JSON.stringify(result));
    }
    else if (req.url === '/v1/chat/completions') {
      const { response_format: format } = JSON.parse(body);
      formats.push(format);
      if (format?.type === 'json_schema' && !schemaAvailable || format?.type === 'json_object' && !jsonModeAvailable) {
        res.writeHead(400).end(JSON.stringify({ error: 'This response_format is unsupported' }));
        return;
      }
      const result = JSON.stringify({
        summary: 'Two cuts', characters: ['Lead'], scenes: [{ title: 'Opening', description: '00:00–00:02' }],
        shots: [
          { title: 'First', prompt: 'Opening scene', duration: 1, dialogue: 'Example dialogue', scene: 'Opening', characters: ['Lead'] },
          { title: 'Second', prompt: 'Cut to the clock', duration: 0, scene: 'Opening' },
          { title: 'Third', prompt: 'Show the dial', duration: 147, scene: 'Opening' },
        ],
      });
      res.end(JSON.stringify({
        choices: [{ message: { content: format ? result : '```json\n' + result + '\n```' } }],
      }));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = {
    url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'test', model: 'test', vision: true,
  };
  const { shots, ...result } = await services.analyze(config, templates[0], { script: 'A reference' }, { reference: movie });
  assert.ok(result.sceneCuts.some(cut => Math.abs(cut.start - 1) < 0.15), JSON.stringify(result.sceneCuts));
  const form = received['/v1/audio/transcriptions'];
  assert.match(form, /filename="audio-000.mp3"/);
  assert.match(received['/v1/chat/completions'], /Example dialogue/);
  assert.match(received['/v1/chat/completions'], /data:image\/jpeg;base64/);
  assert.deepEqual(result.referenceSources, { script: true, frames: 2, transcription: 'used' });
  assert.equal(result.referenceTranscript, 'Example dialogue');
  assert.equal(formats[0].json_schema.schema.properties.shots.minItems, 1);
  assert.deepEqual([shots[0].scene, shots[0].characters], ['Opening', ['Lead']]);
  assert.deepEqual(shots.map(shot => shot.duration), [1, 4, 4]);
  result.scenes[0].description = 'Revised scene direction';
  const revised = await services.suggestShots(config, templates[0], result, { script: 'A reference' });
  assert.deepEqual(revised.map(shot => shot.duration), [1, 4, 4]);
  assert.equal(revised[0].dialogue, 'Example dialogue');
  assert.match(received['/v1/chat/completions'], /Revised scene direction/);
  const revision = JSON.parse(JSON.parse(received['/v1/chat/completions']).messages[1].content);
  assert.equal(revision.analysis.referenceTranscript, 'Example dialogue');
  assert.deepEqual(revision.analysis.sceneCuts, result.sceneCuts);
  assert.equal(audioRequests, 1);

  const originalAnalysis = { ...result, referenceTranscript: undefined };
  const oldRevision = await services.suggestShots(config, templates[0], originalAnalysis, {});
  assert.ok(oldRevision.every(shot => shot.dialogue === ''));
  assert.equal(audioRequests, 1);

  transcriptionStatus = 404;
  const fallbackVisual = await services.analyze(config, templates[0], {}, { reference: movie });
  assert.equal(fallbackVisual.referenceTranscript, undefined);
  assert.deepEqual(fallbackVisual.referenceSources, { script: false, frames: 2, transcription: 'unavailable' });
  assert.ok(fallbackVisual.shots.every(shot => shot.dialogue === ''));
  assert.match(received['/v1/chat/completions'], /data:image\/jpeg;base64/);
  assert.doesNotMatch(received['/v1/chat/completions'], /参考视频转写：/);
  const revisedVisual = await services.suggestShots(config, templates[0], {
    ...fallbackVisual, summary: 'Revised visual direction',
  }, {});
  assert.ok(revisedVisual.every(shot => shot.dialogue === ''));
  assert.match(received['/v1/chat/completions'], /Revised visual direction/);

  transcriptionStatus = 400;
  for (const code of ['model_not_found', 'unsupported_model']) {
    transcriptionError = { code, message: 'Transcription model is unavailable' };
    const modelFallback = await services.analyze(config, templates[0], {}, { reference: movie });
    assert.deepEqual(modelFallback.referenceSources, { script: false, frames: 2, transcription: 'unavailable' });
    assert.ok(modelFallback.shots.every(shot => shot.dialogue === ''));
  }
  transcriptionError = { code: 'invalid_request_error', message: 'Audio format is invalid' };
  const beforeInvalidAudio = formats.length;
  await assert.rejects(services.analyze(config, templates[0], {}, { reference: movie }), { status: 400 });
  assert.equal(formats.length, beforeInvalidAudio);
  transcriptionError = undefined;

  transcriptionStatus = 501;
  const fallbackScript = await services.analyze({ ...config, vision: false }, templates[0],
    { script: 'Written dialogue' }, { reference: movie });
  assert.deepEqual(fallbackScript.referenceSources, { script: true, frames: 0, transcription: 'unavailable' });
  assert.match(received['/v1/chat/completions'], /Written dialogue/);
  assert.doesNotMatch(received['/v1/chat/completions'], /data:image\/jpeg;base64/);
  await assert.rejects(services.analyze({ ...config, vision: false }, templates[0], {}, { reference: movie }),
    /语音转写接口或转写模型不可用.*开启视觉分析/);
  transcriptionStatus = 401;
  const chatRequests = formats.length;
  await assert.rejects(services.analyze(config, templates[0], {}, { reference: movie }), { status: 401 });
  assert.equal(formats.length, chatRequests);
  transcriptionStatus = 503;
  const temporaryFallback = await services.analyze(config, templates[0], {}, { reference: movie });
  assert.deepEqual(temporaryFallback.referenceSources, { script: false, frames: 2, transcription: 'unavailable' });
  assert.ok(temporaryFallback.shots.every(shot => shot.dialogue === ''));
  await assert.rejects(services.analyze({ ...config, vision: false }, templates[0], {}, { reference: movie }), { status: 503 });
  assert.equal(formats.length, chatRequests + 1);

  transcriptionStatus = 200;
  transcript = null;
  const missingText = await services.analyze(config, templates[0], {}, { reference: movie });
  assert.deepEqual(missingText.referenceSources, { script: false, frames: 2, transcription: 'unavailable' });
  assert.ok(missingText.shots.every(shot => shot.dialogue === ''));
  const beforeUnavailable = formats.length;
  await assert.rejects(services.analyze({ ...config, vision: false }, templates[0], {}, { reference: movie }),
    /语音转写接口或转写模型不可用/);
  assert.equal(formats.length, beforeUnavailable);
  transcriptionBody = '<html>Audio service unavailable</html>';
  const malformed = await services.analyze({ ...config, vision: false }, templates[0],
    { script: 'Written dialogue with unavailable transcription' }, { reference: movie });
  assert.deepEqual(malformed.referenceSources, { script: true, frames: 0, transcription: 'unavailable' });
  assert.match(received['/v1/chat/completions'], /Written dialogue with unavailable transcription/);
  transcriptionBody = undefined;
  transcript = '   ';
  const emptyTranscript = await services.analyze(config, templates[0], {}, { reference: movie });
  assert.equal(emptyTranscript.referenceSources.transcription, 'empty');
  assert.ok(emptyTranscript.shots.every(shot => shot.dialogue === ''));

  schemaAvailable = false;

  const continuous = path.join(directory, 'continuous.mp4');
  ff('-f', 'lavfi', '-i', 'color=blue:s=160x90:r=25:d=8', '-f', 'lavfi', '-i', 'sine=440:d=8',
    '-c:v', 'libx264', '-c:a', 'aac', continuous);
  delete received['/v1/audio/transcriptions'];
  const visualOnly = await services.analyze({ ...config, transcriptionEnabled: false }, templates[0], {}, { reference: continuous });
  assert.equal(visualOnly.sceneCuts.length, 1);
  assert.deepEqual(visualOnly.referenceSources, { script: false, frames: 4, transcription: 'skipped' });
  assert.equal(received['/v1/audio/transcriptions'], undefined);
  const content = JSON.parse(received['/v1/chat/completions']).messages[1].content;
  const times = content.flatMap(item => item.text?.match(/^时间 ([\d.]+) 秒$/)?.[1] || []).map(Number);
  assert.deepEqual(times, [0, 2, 4, 6]);
  assert.equal(content.filter(item => item.type === 'image_url').length, times.length);
  assert.deepEqual(formats.slice(-2).map(format => format.type), ['json_schema', 'json_object']);
  jsonModeAvailable = false;
  const plain = await services.analyze(config, templates[0], { script: 'A script' });
  assert.equal(plain.summary, 'Two cuts');
  assert.deepEqual(formats.slice(-3).map(format => format?.type), ['json_schema', 'json_object', undefined]);
  const plainInput = JSON.parse(received['/v1/chat/completions']).messages[1].content;
  const shape = JSON.parse(plainInput.split('\n').at(-1));
  assert.deepEqual(Object.keys(shape), ['summary', 'characters', 'scenes', 'shots']);
  assert.deepEqual(Object.keys(shape.shots[0]), ['title', 'prompt', 'duration', 'dialogue', 'scene', 'characters']);
  await assert.rejects(services.analyze({ ...config, vision: false, transcriptionEnabled: false },
    templates[0], {}, { reference: continuous }), /开启视觉分析、填写剧本/);
});

test('AI analysis corrects malformed output and falls back from an unreliable structured format', async t => {
  const requests = [];
  const valid = {
    summary: 'Opening', characters: [], scenes: [{ title: 'Opening', description: 'A window' }],
    shots: [{ title: 'Opening', prompt: 'Pan across the window', duration: 2 }],
  };
  let replies;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const choice = replies.shift();
    if (!choice) return res.writeHead(500).end('Unexpected repeat');
    if (choice.unsupported) return res.writeHead(400).end('response_format is unsupported');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [choice] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = { url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'test', model: 'test' };
  const analyze = () => services.analyze(config, templates[0], { script: 'Pan across the window' });
  const reply = value => ({ message: { content: JSON.stringify(value) } });
  replies = [reply({ ...valid, shots: undefined }), reply(valid)];
  assert.equal((await analyze()).shots[0].prompt, valid.shots[0].prompt);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, requests[1].response_format);
  const corrected = requests[1].messages[1].content;
  assert.ok(corrected.startsWith(requests[0].messages[1].content));
  assert.match(corrected, /上次输出未通过校验/);
  assert.ok(JSON.parse(corrected.split('\n').at(-1)).shots[0]);

  const truncated = { finish_reason: 'stop', message: { content: '{"summary":"incomplete' } };
  replies = [truncated, truncated, { unsupported: true }, reply(valid)];
  assert.equal((await analyze()).summary, 'Opening');
  assert.deepEqual(requests.slice(2).map(request => request.response_format?.type),
    ['json_schema', 'json_schema', 'json_object', undefined]);
  const fallback = requests.at(-1).messages[1].content;
  assert.ok(fallback.startsWith(requests[0].messages[1].content));
  assert.match(fallback, /上次输出未通过校验/);

  replies = [truncated, truncated, truncated, truncated];
  await assert.rejects(analyze(), /未返回有效 JSON/);
  assert.equal(requests.length, 10);
  replies = [{ message: { refusal: 'Refused' } }];
  await assert.rejects(analyze(), /拒绝分析/);
  replies = [{ finish_reason: 'length' }];
  await assert.rejects(analyze(), /长度上限/);
  assert.equal(requests.length, 12);
});

test('long reference analysis keeps successful segments around a failed transcription and retries only the gap', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const movie = path.join(directory, 'long-reference.mp4');
  ff('-f', 'lavfi', '-i', 'color=blue:s=64x64:r=1:d=1', '-f', 'lavfi', '-i', 'sine=440:sample_rate=8000:d=1081',
    '-c:v', 'libx264', '-c:a', 'aac', movie);
  const dialogue = ['The first ferry leaves.', 'Close the gate.', 'The last ferry arrives.'];
  const shown = ['The first ferry leaves!', 'This dialogue was invented.', dialogue[2]];
  const uploads = [];
  const requests = [];
  let unavailable = true;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/audio/transcriptions') {
        const index = Number(/filename="audio-(\d+)\.mp3"/.exec(text)?.[1]);
        assert.ok(index >= 0 && index < dialogue.length);
        uploads.push(index);
        if (index === 1 && unavailable) response.writeHead(503).end('{}');
        else response.end(JSON.stringify({ text: dialogue[index] }));
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      requests.push(JSON.parse(text).messages);
      const result = {
        summary: 'A ferry service', characters: [], scenes: [],
        shots: shown.map((line, index) => ({ title: 'Shot ' + index, prompt: 'A ferry at the dock', duration: 1, dialogue: line })),
      };
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = { url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture', model: 'fixture', vision: false };
  const checkpoints = [];
  const { shots, ...analysis } = await services.analyze(config, templates[0], {}, {
    reference: movie, transcription: { saveSegments: segments => checkpoints.push(segments) },
  });
  assert.deepEqual(uploads, [0, 1, 2]);
  assert.deepEqual(checkpoints, [[dialogue[0], null, null], [dialogue[0], null, dialogue[2]]]);
  assert.deepEqual(analysis.referenceSources, {
    script: false, frames: 0, transcription: 'partial', transcriptionProgress: { total: 3, missing: [2] },
  });
  assert.equal(analysis.referenceTranscript, [dialogue[0], dialogue[2]].join('\n'));
  assert.match(requests[0][1].content, /缺少第 2 段/);
  assert.deepEqual(shots.map(shot => shot.dialogue), [shown[0], '', shown[2]]);
  const revised = await services.suggestShots(config, templates[0], analysis, {});
  assert.deepEqual(revised.map(shot => shot.dialogue), [shown[0], '', shown[2]]);
  assert.match(requests[1][0].content, /缺少第 2 段/);
  assert.equal(JSON.parse(requests[1][1].content).analysis.referenceSources.transcription, 'partial');

  unavailable = false;
  const complete = await services.analyze(config, templates[0], {}, {
    reference: movie, transcription: { savedSegments: checkpoints.at(-1) },
  });
  assert.deepEqual(uploads, [0, 1, 2, 1]);
  assert.deepEqual(complete.referenceSources, { script: false, frames: 0, transcription: 'used' });
  assert.equal(complete.referenceTranscript, dialogue.join('\n'));
});

test('reference analysis labels real pictures and sends the complete audio of delayed and sparse video', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const source = path.join(directory, 'short-picture.mp4');
  const delayed = path.join(directory, 'audio-tail.mp4');
  const sparse = path.join(directory, 'sparse.mp4');
  ff('-f', 'lavfi', '-i', 'color=blue:s=160x90:r=1:d=1', '-f', 'lavfi', '-i', 'sine=440:d=10',
    '-c:v', 'libx264', '-c:a', 'aac', source);
  ff('-itsoffset', '1.25', '-i', source, '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', delayed);
  ff('-f', 'lavfi', '-i', 'color=blue:s=160x90:r=4:d=12', '-vf', "select='eq(n,0)+eq(n,3)+eq(n,42)'",
    '-c:v', 'libx264', '-fps_mode', 'vfr', sparse);

  let content;
  let audioDuration;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/audio/transcriptions') {
        const data = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = path.join(directory, 'uploaded-audio.mp3');
        fs.writeFileSync(file, Buffer.from(await data.get('file').arrayBuffer()));
        audioDuration = (await media.probe(file)).duration;
        res.end(JSON.stringify({ text: 'Dialogue in the audio-only tail' }));
      } else if (req.url === '/v1/chat/completions') {
        content = JSON.parse(body).messages[1].content;
        const result = { summary: 'Delayed picture', characters: [], scenes: [],
          shots: [{ title: 'Shot', prompt: 'Blue background', duration: 1, dialogue: 'Dialogue in the audio-only tail' }] };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      } else res.writeHead(404).end('{}');
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = { url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'test', model: 'test', vision: true };
  const timestamps = () => content.flatMap(item => item.text?.match(/^时间 ([\d.]+) 秒$/)?.[1] || []).map(Number);
  const images = () => content.filter(item => item.type === 'image_url');

  const complete = await services.analyze(config, templates[0], {}, { reference: delayed });
  assert.equal((await media.probe(delayed)).duration, 10);
  assert.ok(audioDuration > 9.95);
  assert.deepEqual(complete.sceneCuts, [{ start: 1.25, end: 2.25 }]);
  assert.deepEqual(complete.referenceSources, { script: false, frames: 1, transcription: 'used' });
  assert.deepEqual(timestamps(), [1.25]);
  assert.equal(images().length, 1);
  assert.equal(complete.shots[0].dialogue, 'Dialogue in the audio-only tail');
  const onlyPicture = await services.analyze({ ...config, transcriptionEnabled: false }, templates[0], {}, { reference: delayed });
  assert.deepEqual(onlyPicture.referenceSources, { script: false, frames: 1, transcription: 'skipped' });
  assert.equal(onlyPicture.shots[0].dialogue, '');

  const variable = await services.analyze(config, templates[0], {}, { reference: sparse });
  assert.deepEqual(timestamps(), [0, 10.5], 'sparse frames should carry actual times and appear once');
  assert.equal(images().length, 2);
  assert.equal(variable.referenceSources.frames, 2);
});

test('product vision captures editable appearance and reuses corrections in the revised storyboard', { skip: !hasFFmpeg }, async t => {
  const image = path.join(makeFolder(t), 'product.png');
  ff('-f', 'lavfi', '-i', 'color=red:s=160x90', '-frames:v', '1', image);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: 'Product opening', characters: [], scenes: [],
      productAppearance: { color: ' red ', shape: 'Crew neck', texture: '' },
      shots: [{ title: 'Opening', prompt: 'A medium shot of the shirt', duration: 3 }],
    }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = { url: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'test', model: 'test', vision: true };
  const inputs = { product: 'Shirt', sellingPoints: 'Relaxed fit' };
  const { shots, ...analysis } = await services.analyze(config, templates[1], inputs, { productImage: image });
  assert.equal(requests[0].messages[1].content.filter(item => item.type === 'image_url').length, 1);
  assert.deepEqual(requests[0].response_format.json_schema.schema.properties.productAppearance.required, ['color', 'shape', 'texture']);
  assert.equal(shots[0].title, 'Opening');
  assert.deepEqual(analysis.productAppearance, { color: 'red', shape: 'Crew neck', texture: '' });
  analysis.productAppearance.color = 'Burgundy';
  await services.suggestShots(config, templates[1], analysis, inputs);
  assert.match(requests[1].messages[0].content, /保留用户确认的 productAppearance/);
  assert.equal(JSON.parse(requests[1].messages[1].content).analysis.productAppearance.color, 'Burgundy');
});

test('on-demand setup reuses its runtime and resumes paused, hash-checked model downloads', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const engine = require('../electron/engine.cjs');
  const directory = makeFolder(t);
  fs.mkdirSync(path.join(directory, 'ComfyUI'), { recursive: true });
  fs.mkdirSync(path.join(directory, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'ComfyUI', 'main.py'), '# Fixture');
  fs.writeFileSync(path.join(directory, 'ComfyUI', 'requirements.txt'), 'torch\n');
  fs.writeFileSync(path.join(directory, 'ComfyUI', '.imodureel-revision'), '265adad858e1f31b66cd3523a02b16f5d34ced52');
  fs.writeFileSync(path.join(directory, '.venv', 'bin', 'python'), 'Fixture');
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({
    revision: '265adad858e1f31b66cd3523a02b16f5d34ced52', python: '3.12.12',
  }));
  assert.equal((await engine.info(directory)).installed, true);
  const content = Buffer.from('A model fixture served through an interrupted connection.');
  const split = 12;
  const item = {
    folder: 'upscale_models', name: 'fixture.safetensors', url: 'https://test.invalid/model',
    size: content.length, sha256: createHash('sha256').update(content).digest('hex'),
  };
  const file = path.join(directory, 'ComfyUI', 'models', item.folder, item.name);
  const nativeTimeout = globalThis.setTimeout;
  let expireIdle;
  t.mock.method(globalThis, 'setTimeout', (callback, duration, ...args) => {
    if (duration === 90000) expireIdle = callback;
    return nativeTimeout(callback, duration, ...args);
  });
  const requestedRanges = [];
  const secondSplit = split + 5;
  let waitingForHeaders;
  const connected = new Promise(resolve => { waitingForHeaders = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, item.url);
    requestedRanges.push(options.headers.Range);
    if (requestedRanges.length === 1) {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        waitingForHeaders();
      });
    }
    if (requestedRanges.length === 2) {
      return new Response(new ReadableStream({ start: controller => controller.enqueue(content.subarray(0, split)) }));
    }
    const offset = requestedRanges.length === 3 ? split : secondSplit;
    assert.equal(options.headers.Range, `bytes=${offset}-`);
    const headers = { 'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}` };
    if (requestedRanges.length === 3) {
      return new Response(new ReadableStream({ start: controller => controller.enqueue(content.subarray(offset, secondSplit)) }), {
        status: 206, headers,
      });
    }
    return new Response(content.subarray(offset), {
      status: 206, headers,
    });
  });
  const stalled = assert.rejects(engine.setup(directory, [item]), /下载连接已超时.*重试/);
  await connected;
  expireIdle();
  await stalled;
  t.after(() => engine.pause());
  async function waitForPartial(size) {
    for (let i = 0; i < 100 && fs.statSync(file + '.part', { throwIfNoEntry: false })?.size !== size; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fs.statSync(file + '.part').size, size);
  }
  const inactive = assert.rejects(engine.setup(directory, [item]), /已下载的部分会保留/);
  await waitForPartial(split);
  expireIdle();
  await inactive;
  const interrupted = assert.rejects(engine.setup(directory, [item]), /安装已暂停/);
  try {
    await waitForPartial(secondSplit);
    assert.equal(engine.modelDownloadBytes(directory, [item]), content.length - secondSplit);
    await assert.rejects(engine.setup(directory, [item]), /已有本地引擎安装或下载任务/);
  } finally {
    assert.equal(engine.pause(), true);
  }
  await interrupted;
  assert.equal((await engine.setup(directory, [item])).dir, path.resolve(directory));
  assert.deepEqual(fs.readFileSync(file), content);
  assert.deepEqual(requestedRanges, [undefined, undefined, `bytes=${split}-`, `bytes=${secondSplit}-`]);
  assert.equal(engine.modelDownloadBytes(directory, [item]), 0);
  fs.writeFileSync(file, Buffer.alloc(content.length));
  await assert.rejects(engine.setup(directory, [item]), /文件与清单不匹配/);
});

test('managed setup passes dependency files relative to an installation directory with spaces', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const engine = require('../electron/engine.cjs');
  const directory = path.join(makeFolder(t), 'engine with spaces');
  const source = path.join(directory, 'ComfyUI');
  const tooling = path.join(directory, '.uv');
  const python = path.join(directory, '.venv/bin/python');
  for (const folder of [source, tooling, path.dirname(python)]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.py'), '# Fixture');
  fs.writeFileSync(path.join(source, 'requirements.txt'), 'torch\n');
  fs.writeFileSync(path.join(source, '.imodureel-revision'), '265adad858e1f31b66cd3523a02b16f5d34ced52');
  fs.writeFileSync(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(tooling, 'fixture-node'));
  fs.writeFileSync(path.join(tooling, 'uv'), '#!/bin/sh\nexec "$(dirname "$0")/fixture-node" "$(dirname "$0")/uv.cjs" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tooling, 'uv.cjs'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === 'pip') fs.writeFileSync('pip-invocation.json', JSON.stringify(args));
  `);
  t.mock.method(fs.promises, 'statfs', async () => ({ bavail: 1024 ** 2, bsize: 4096 }));
  assert.equal((await engine.setup(directory, [])).dir, directory);
  const args = JSON.parse(fs.readFileSync(path.join(directory, 'pip-invocation.json'), 'utf8'));
  assert.deepEqual(args, ['pip', 'install', '--python', python, '-c', '.torch-constraints.txt', '-r', path.join('ComfyUI', 'requirements.txt')]);
  assert.match(fs.readFileSync(path.join(directory, '.torch-constraints.txt'), 'utf8'), /^torch==2\.8\.0$/m);
  assert.equal((await engine.info(directory)).installed, true);
});

test('managed Windows setup resumes CUDA repair and restores stock ComfyUI files without touching user data', t => {
  const directory = path.join(makeFolder(t), 'engine with spaces');
  const result = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const [directory, enginePath, commandPath, nvidiaPath, sourcePath] = process.argv.slice(1);
    const installCommand = require(commandPath);
    const nvidia = require(nvidiaPath);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const python = path.join(directory, '.venv', 'Scripts', 'python.exe');
    const uv = path.join(directory, '.uv', 'uv.exe');
    const source = path.join(directory, 'ComfyUI');
    for (const file of [python, uv, path.join(source, 'requirements.txt'), path.join(source, 'main.py')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
    }
    fs.writeFileSync(path.join(source, '.imodureel-revision'), '265adad858e1f31b66cd3523a02b16f5d34ced52');
    fs.promises.statfs = async () => ({ bavail: 5 * 2 ** 18, bsize: 4096 });
    const wheels = ['torch==2.8.0+cu128', 'torchvision==0.23.0+cu128', 'torchaudio==2.8.0+cu128'];
    const constraints = '.torch-constraints.txt';
    const index = 'https://download.pytorch.org/whl/cu128';
    const mirror = 'https://packages.example.test/simple';
    const commands = [];
    let failVerification = true;
    let pauseRepair = false;
    const manifest = path.join(directory, 'installation.json');
    installCommand.waitForPreviousCommands = async () => {};
    let repairedSource = 0;
    installCommand.command = async (file, args, cwd, options) => {
      assert.equal(cwd, directory);
      if (file === 'tar') {
        assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).state, 'repairing');
        const staged = args[args.indexOf('-C') + 1];
        fs.writeFileSync(path.join(staged, 'main.py'), 'original main');
        fs.writeFileSync(path.join(staged, 'requirements.txt'), 'original requirements');
        for (const folder of ['models', 'input', 'output', 'temp', 'user', 'custom_nodes']) {
          fs.mkdirSync(path.join(staged, folder), { recursive: true });
          fs.writeFileSync(path.join(staged, folder, 'retained'), 'stock placeholder');
        }
        repairedSource++;
        return;
      }
      commands.push([file, ...args]);
      if (file === uv) assert.equal(options.env.UV_DEFAULT_INDEX, mirror);
      if (args.includes('--reinstall')) assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).state, 'repairing');
      if (args[0] === 'pip' && pauseRepair) require(enginePath).pause();
      if (file === python && failVerification) throw new Error('fixture GPU check failure');
    };
    const managedSource = require(sourcePath);
    const ensureComfySource = managedSource.ensureComfySource;
    managedSource.ensureComfySource = (dir, options) =>
      ensureComfySource(dir, { ...options, getArchive: async () => 'validated fixture archive' });
    nvidia.nvidiaInfo = async () => ({ supported: true, backend: 'CUDA', name: 'NVIDIA fixture' });
    const pip = [uv, 'pip', 'install', '--python', python];
    (async () => {
      const engine = require(enginePath);
      await assert.rejects(engine.setup(path.join(directory, 'new install'), []), /所选目录空间不足/);
      assert.equal(commands.length, 0);
      fs.writeFileSync(manifest, JSON.stringify({ revision: 'other version', python: '3.12.12' }));
      await assert.rejects(engine.start(directory), /安装记录无效或版本不匹配/);
      fs.unlinkSync(manifest);
      assert.equal((await engine.info(directory)).resumable, true);
      await assert.rejects(engine.setup(directory, [], undefined, { packageIndex: mirror }), /CUDA 运算校验失败/);
      assert.equal((await engine.info(directory)).installed, false);
      failVerification = false;
      commands.length = 0;
      assert.equal((await engine.setup(directory, [], undefined, { packageIndex: mirror })).dir, directory);
      assert.deepEqual(commands.slice(1, 3), [
        [...pip, '--default-index', index, ...wheels],
        [...pip, '-c', constraints, '-r', path.join('ComfyUI', 'requirements.txt')],
      ]);
      assert.equal(commands.length, 4);
      assert.equal(commands[3][0], python);
      assert.match(commands[3][2], /torch.version.cuda == "12.8"/);
      assert.equal(fs.readFileSync(path.join(directory, constraints), 'utf8'), [...wheels, 'transformers<5'].join('\\n') + '\\n');
      assert.equal((await engine.info(directory)).installed, true);

      const retained = ['models/retained', 'input/retained', 'output/retained', 'temp/retained', 'user/retained', 'custom_nodes/retained']
        .map(file => path.join(source, file));
      for (const file of retained) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'retained');
      }
      fs.writeFileSync(path.join(source, 'main.py'), 'corrupt program');
      fs.unlinkSync(path.join(source, 'requirements.txt'));
      fs.unlinkSync(path.join(source, '.imodureel-revision'));
      assert.equal((await engine.info(directory)).installed, false);
      await assert.rejects(engine.start(directory), /修复尚未完成/);
      pauseRepair = true;
      await assert.rejects(engine.setup(directory, [], undefined, { packageIndex: mirror }), /安装已暂停/);
      const pending = await engine.info(directory);
      assert.equal(pending.repairing, true);
      assert.equal(pending.installed, false);
      await assert.rejects(engine.start(directory), /修复尚未完成/);
      commands.length = 0;
      pauseRepair = failVerification = false;
      await engine.setup(directory, [], undefined, { packageIndex: mirror });
      assert.deepEqual(commands[0], [uv, 'python', 'install', '--no-bin', '--no-registry', '--reinstall', '3.12.12']);
      assert.deepEqual(commands[1], [uv, 'venv', '--allow-existing', '--managed-python', '--python', '3.12.12', path.dirname(path.dirname(python))]);
      assert.deepEqual(commands[2].slice(0, 6), [...pip, '--reinstall']);
      assert.deepEqual(commands[2].slice(6, 9).map(url => {
        const { pathname, hash } = new URL(url);
        assert.match(hash, /^#sha256=[a-f0-9]{64}$/);
        return decodeURIComponent(path.basename(pathname));
      }), ['torch-2.8.0+cu128-cp312-cp312-win_amd64.whl',
        'torchvision-0.23.0+cu128-cp312-cp312-win_amd64.whl', 'torchaudio-2.8.0+cu128-cp312-cp312-win_amd64.whl']);
      assert.deepEqual(commands[2].slice(9), ['-c', constraints, '-r', path.join('ComfyUI', 'requirements.txt')]);
      assert.equal((await engine.info(directory)).installed, true);
      assert.equal((await engine.info(directory)).repairing, false);
      assert.equal(repairedSource, 2);
      assert.equal(fs.readFileSync(path.join(source, 'main.py'), 'utf8'), 'original main');
      assert.equal(fs.readFileSync(path.join(source, 'requirements.txt'), 'utf8'), 'original requirements');
      for (const file of retained) assert.equal(fs.readFileSync(file, 'utf8'), 'retained');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, directory, require.resolve('../electron/engine.cjs'), require.resolve('../electron/install-command.cjs'),
  require.resolve('../electron/nvidia.cjs'), require.resolve('../electron/engine-source.cjs')], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('installer commands and their subprocesses stop when their owner exits forcefully', async t => {
  const { command, waitForPreviousCommands } = require('../electron/install-command.cjs');
  const directory = makeFolder(t);
  const logger = name => `
    const fs = require('node:fs');
    setInterval(() => fs.appendFileSync(${JSON.stringify(name)}, 'x'), 30);
    setTimeout(() => process.exit(), 10000);
  `;
  const fixture = path.join(directory, 'installer.cjs');
  fs.writeFileSync(fixture, `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(logger('worker.log'))}], { stdio: 'ignore' });
    ${logger('tool.log')}
  `);
  const owner = spawn(process.execPath, ['-e', `
    require(process.argv[1]).command(process.execPath, [process.argv[2]], process.argv[3])
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  `, require.resolve('../electron/install-command.cjs'), fixture, directory], { stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const files = ['tool.log', 'worker.log'].map(name => path.join(directory, name));
  const deadline = Date.now() + 5000;
  while (!files.every(file => fs.existsSync(file)) && Date.now() < deadline) await delay(20);
  assert.ok(files.every(file => fs.statSync(file).size > 0));
  const closed = once(owner, 'close');
  assert.equal(owner.kill('SIGKILL'), true);
  await closed;
  await waitForPreviousCommands(directory, AbortSignal.timeout(6000));
  const sizes = files.map(file => fs.statSync(file).size);
  await delay(160);
  assert.deepEqual(files.map(file => fs.statSync(file).size), sizes);
  assert.equal((await command(process.execPath, ['-p', '"restarted"'], directory)).trim(), 'restarted');
});

test('Windows CUDA preflight detects standard NVIDIA installations and checks the pinned wheel requirements', async () => {
  const { nvidiaInfo, cudaRuntimeEnv } = require('../electron/nvidia.cjs');
  const tried = [];
  const env = { SystemRoot: 'D:\\Windows', ProgramW6432: 'C:\\Program Files' };
  const modern = 'GPU-12345678-abcd-1234-abcd-123456789abc';
  const pascal = 'GPU-87654321-dcba-4321-dcba-abcdef123456';
  const info = await nvidiaInfo({ env, run: async (executable, args, options) => {
    tried.push(executable);
    assert.deepEqual(args, ['--query-gpu=uuid,name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits']);
    assert.equal(options.windowsHide, true);
    if (executable.startsWith('D:')) throw new Error('missing from System32');
    return { stdout: `${pascal}, NVIDIA GTX 1080, 8192, 572.16, 6.1\r\n${modern}, "NVIDIA RTX, test model", 12288, 572.16, 8.6\r\n` };
  } });
  assert.deepEqual(tried, ['D:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']);
  assert.deepEqual(info, {
    supported: true, backend: 'CUDA', name: 'NVIDIA RTX, test model · 12288 MiB',
    driverVersion: '572.16', deviceUUID: modern,
  });
  assert.deepEqual(cudaRuntimeEnv(info, env), { ...env, CUDA_VISIBLE_DEVICES: modern });
  assert.equal(env.CUDA_VISIBLE_DEVICES, undefined);
  const explicit = { cuda_visible_devices: '' };
  assert.strictEqual(cudaRuntimeEnv(info, explicit), explicit);
  const old = await nvidiaInfo({ env: {}, run: async executable => {
    assert.equal(executable, 'nvidia-smi.exe');
    return { stdout: `${modern}, NVIDIA RTX, 8192, 528.9, 7.5` };
  } });
  assert.equal(old.supported, false);
  assert.match(old.name, /528\.9.*528\.33/);
  const minimum = await nvidiaInfo({ env: {}, run: async () => ({ stdout: `${modern}, NVIDIA RTX, 8192, 528.33, 7.5` }) });
  assert.equal(minimum.supported, true);
  assert.strictEqual(cudaRuntimeEnv(minimum, env), env);
  const legacy = await nvidiaInfo({ env: {}, run: async () => ({ stdout: `${pascal}, NVIDIA GTX 1080, 8192, 572.16, 6.1` }) });
  assert.equal(legacy.supported, false);
  assert.match(legacy.name, /计算能力至少为 7\.0.*GTX 1080/);
  const unknown = await nvidiaInfo({ env: {}, run: async () => ({ stdout: '[N/A], NVIDIA device, [N/A], 572.16, [N/A]' }) });
  assert.equal(unknown.supported, true);
  const missing = await nvidiaInfo({ env: {}, run: async () => ({ stdout: '' }) });
  assert.equal(missing.supported, false);
});

test('local engine checks its device and can restart after a startup failure', { skip: process.platform !== 'darwin' }, async t => {
  const engine = require('../electron/engine.cjs');
  const directory = makeFolder(t);
  t.after(() => engine.stop());
  fs.mkdirSync(path.join(directory, 'ComfyUI'));
  fs.mkdirSync(path.join(directory, '.venv/bin'), { recursive: true });
  const executable = path.join(directory, '.venv/bin/python');
  const revision = '265adad858e1f31b66cd3523a02b16f5d34ced52';
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ revision, python: '3.12.12' }));
  fs.writeFileSync(path.join(directory, 'ComfyUI/.imodureel-revision'), revision);
  fs.writeFileSync(path.join(directory, 'ComfyUI/main.py'), '# Fixture');
  fs.writeFileSync(path.join(directory, 'ComfyUI/requirements.txt'), 'torch\n');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  if (process.arch !== 'arm64') {
    await assert.rejects(engine.start(directory), /连接已有 ComfyUI 实例/);
    return;
  }
  await assert.rejects(engine.start(directory), /退出：9/);
  fs.symlinkSync(process.execPath, path.join(directory, '.venv/bin/fixture-node'));
  fs.writeFileSync(executable, '#!/bin/sh\nshift 3\nexec "$(dirname "$0")/fixture-node" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'ComfyUI/main.py'), `
    const http = require('node:http');
    const fs = require('node:fs');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const devices = [{ type: fs.readFileSync('device.txt', 'utf8') }];
      res.end(JSON.stringify({ system: { comfyui_version: '0.3.68' }, devices }));
    }).listen(port, '127.0.0.1');
  `);
  const device = path.join(directory, 'ComfyUI/device.txt');
  fs.writeFileSync(device, 'cpu');
  await assert.rejects(engine.start(directory), /未使用 MPS 加速/);
  assert.equal(engine.runningInstance(), null);
  fs.writeFileSync(device, 'mps');
  const url = await engine.start(directory);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(engine.runningInstance().url, url);
  assert.ok((await fetch(url + '/system_stats')).ok);
  const stopping = engine.stop();
  assert.equal(engine.runningInstance(), null);
  const restarting = engine.start(directory);
  await stopping;
  const newUrl = await restarting;
  assert.equal(engine.runningInstance().url, newUrl);
  assert.ok((await fetch(newUrl + '/system_stats')).ok);
});

test('rough cut appends approved shots and their dialogue in storyboard order, atomically', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Episode', path.join(directory, 'project'), templates[0]);
  const fixture = path.join(directory, 'placeholder.mp4');
  fs.writeFileSync(fixture, 'The store only copies this fixture; render tests cover media decoding separately.');
  const [first, second] = store.setShots(project.id, [
    { title: 'Arrival', prompt: 'A character arrives', dialogue: 'I am here.', duration: 3, scene: 'Station', characters: ['Lead'] },
    { title: 'Departure', prompt: 'The character leaves', dialogue: 'Goodbye.', duration: 4 },
  ], true);
  const subtitles = store.addTrack(project.id, 'subtitle', 'Captions');
  store.addClip(subtitles.id, { text: 'Already edited', duration: 1.5 });
  const bundle = {
    workflow: { '1': { class_type: 'Prompt', inputs: { text: '' } } },
    mapping: { prompt: { node: '1', input: 'text' } },
  };
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  async function record(shot, duration) {
    const [payload] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
    const job = store.addJob(project.id, 'comfy', payload);
    const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'video', origin: 'comfy', duration, jobId: job.id }]);
    store.updateJob(job.id, {
      status: 'done',
      detail: JSON.stringify({ ...payload, assets: [asset.id] }),
    });
    return asset;
  }

  const late = await record(second, 2);
  await assert.rejects(store.appendStoryboard(project.id), /Arrival/);
  assert.equal(store.project(project.id).tracks.length, 1);
  const early = await record(first, 3.5);
  assert.equal(JSON.parse(store.project(project.id).jobs[0].detail).values.prompt, 'A character arrives\nScene: Station\nCharacters in this shot: Lead');
  store.saveEditorDraft(project.id, 'shots', []);
  await assert.rejects(store.appendStoryboard(project.id), /确认当前分镜/);
  assert.equal(store.project(project.id).tracks.length, 1);
  store.saveEditorDraft(project.id, 'shots', null);
  const [result, duplicate] = await Promise.all([store.appendStoryboard(project.id), store.appendStoryboard(project.id)]);
  assert.deepEqual(result, { clips: 2, start: 1.5, end: 6.5 });
  assert.deepEqual(duplicate, result);
  const timeline = store.project(project.id).tracks;
  assert.deepEqual(timeline.find(track => track.kind === 'video').clips.map(c => [c.asset_id, c.start, c.duration]),
    [[early.id, 1.5, 3], [late.id, 4.5, 2]]);
  assert.deepEqual(timeline.find(track => track.kind === 'subtitle').clips.map(c => [c.text, c.start, c.duration]),
    [['Already edited', 0, 1.5], ['I am here.', 1.5, 3], ['Goodbye.', 4.5, 2]]);
  const [arrival, departure] = timeline.find(track => track.kind === 'video').clips;
  const [intro, arrivalCaption, departureCaption] = timeline.find(track => track.kind === 'subtitle').clips;
  assert.equal(intro.linked_video_id, null);
  assert.equal(arrivalCaption.linked_video_id, arrival.id);
  assert.equal(departureCaption.linked_video_id, departure.id);

  store.updateClip(departure.id, { start: 5.5 });
  store.reorderClip(arrival.id, departure.id, 'after');
  let reordered = store.project(project.id).tracks;
  assert.deepEqual(reordered.find(track => track.kind === 'video').clips.map(c => [c.id, c.start]),
    [[departure.id, 1.5], [arrival.id, 4.5]]);
  assert.deepEqual(reordered.find(track => track.kind === 'subtitle').clips.map(c => [c.id, c.start]),
    [[intro.id, 0], [departureCaption.id, 1.5], [arrivalCaption.id, 4.5]]);

  store.updateClip(arrival.id, { start: 2, in_point: 0.4, duration: 1.5 });
  assert.throws(() => store.reorderClip(arrival.id, departure.id, 'before'), /重叠片段/);
  reordered = store.project(project.id).tracks;
  let caption = reordered.find(track => track.kind === 'subtitle').clips.find(clip => clip.id === arrivalCaption.id);
  assert.deepEqual([caption.start, caption.duration], [2, 1.5]);
  store.updateClip(arrivalCaption.id, { text: 'Edited dialogue' });
  store.updateClip(arrivalCaption.id, { detachCaption: true });
  store.updateClip(arrival.id, { start: 8 });
  store.deleteClip(departure.id);
  await store.init(directory);
  const restored = store.project(project.id);
  assert.equal(restored.tracks.find(track => track.kind === 'video').clips.length, 1);
  const kept = restored.tracks.find(track => track.kind === 'subtitle').clips;
  assert.deepEqual(kept.map(c => [c.id, c.start, c.text, c.linked_video_id]),
    [[intro.id, 0, intro.text, null], [arrivalCaption.id, 2, 'Edited dialogue', null]]);
  assert.deepEqual(await store.appendStoryboard(project.id), { clips: 2, start: 9.5, end: 14.5 });
});

test('rough cut reuses a generated shot after edits that leave its mapped workflow inputs unchanged', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Caption corrections', path.join(directory, 'project'), templates[0]);
  const fixture = path.join(directory, 'result.mp4');
  fs.writeFileSync(fixture, 'Media fixture');
  const initial = { prompt: 'A close-up', duration: 1, dialogue: 'Draft line' };
  const [shot] = store.setShots(project.id, [initial], true);
  const options = () => store.storyboardResults(project.id).shots[0];
  const approve = patch => store.setShots(project.id, [{ ...shot, ...patch }], true);
  const recordResult = async bundle => {
    store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
    const [request] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
    const job = store.addJob(project.id, 'comfy', request);
    const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'video', duration: 25 / 24, origin: 'comfy', jobId: job.id }]);
    store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...request, assets: [asset.id] }) });
    return asset;
  };
  const generated = await recordResult(preset('drama', 'video'));
  await store.chooseShotResult(project.id, shot.id, generated.id);
  approve({ dialogue: 'Final line', duration: 0.95 });
  assert.equal(options().candidates[0].assetId, generated.id);
  assert.equal(options().selectedAssetId, generated.id);
  assert.equal((await store.appendStoryboard(project.id)).end, 0.95);
  assert.deepEqual(store.project(project.id).tracks.find(track => track.kind === 'subtitle').clips.map(clip => clip.text), ['Final line']);
  approve({ dialogue: 'Final line', duration: 1.12 });
  assert.deepEqual(options().candidates, []);
  approve({ prompt: 'A wide shot' });
  assert.deepEqual(options().candidates, []);
  approve({});
  const custom = await recordResult({
    workflow: { '1': { class_type: 'Prompt', inputs: { text: '', spoken: '', seconds: 1 } } },
    mapping: { prompt: { node: '1', input: 'text' }, dialogue: { node: '1', input: 'spoken' }, duration: { node: '1', input: 'seconds' } },
  });
  assert.equal(options().candidates[0].assetId, custom.id);
  approve({ duration: 0.95 });
  assert.deepEqual(options().candidates, []);
  approve({ dialogue: 'Final line' });
  assert.deepEqual(options().candidates, []);
});

test('rough cut requires outputs for the current input assets and workflow', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Fashion', path.join(directory, 'project'), templates[1]);
  const product = path.join(directory, 'product.png');
  const replacement = path.join(directory, 'replacement.png');
  fs.writeFileSync(product, 'Original fixture');
  fs.writeFileSync(replacement, 'Replacement fixture');
  const [first, second] = await store.addMedia(project.id, [
    { src: product, kind: 'image' }, { src: replacement, kind: 'image' },
  ]);
  const [shot] = store.setShots(project.id, [{ prompt: 'Show the product', duration: 1 }], true);
  const bundle = {
    workflow: { '1': { class_type: 'Prompt', inputs: { text: '', image: '', seed: 0 } } },
    mapping: { prompt: { node: '1', input: 'text' }, productImage: { node: '1', input: 'image' } },
  };
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  store.saveProduction(project.id, { inputs: { productImage: first.id } });
  const [payload] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
  const job = store.addJob(project.id, 'comfy', payload);
  const [generated] = await store.addMedia(project.id, [{ src: product, kind: 'image', origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [generated.id] }) });
  assert.equal((await store.appendStoryboard(project.id)).clips, 1);
  store.saveProduction(project.id, { inputs: { productImage: second.id } });
  await assert.rejects(store.appendStoryboard(project.id), /没有对应的可用结果/);
  store.saveProduction(project.id, { inputs: { productImage: first.id } });
  const modified = structuredClone(bundle.workflow);
  modified['1'].inputs.seed = 1;
  store.saveWorkflow(project.id, modified, bundle.mapping);
  await assert.rejects(store.appendStoryboard(project.id), /没有对应的可用结果/);
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  await store.relinkAsset(first.id, replacement, { kind: 'image' });
  await assert.rejects(store.appendStoryboard(project.id), /重新确认分镜/);
  store.setShots(project.id, [shot], true);
  await assert.rejects(store.appendStoryboard(project.id), /没有对应的可用结果/);
});

test('short drama rough cuts place and edit linked dialogue audio without losing source timing', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Dialogue audio', path.join(directory, 'project'), templates[0]);
  const footage = path.join(directory, 'shot.mp4');
  const audioFile = path.join(directory, 'line.wav');
  const longFile = path.join(directory, 'long-line.wav');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=24:d=2', '-c:v', 'libx264', footage);
  ff('-f', 'lavfi', '-i', 'sine=frequency=621:sample_rate=48000:d=0.75', audioFile);
  ff('-f', 'lavfi', '-i', 'sine=frequency=717:sample_rate=48000:d=2', longFile);
  const { imported: [voice, tooLong] } = await services.importMedia(project.id, [audioFile, longFile]);
  const [opening, ending] = store.setShots(project.id, [
    { title: 'Opening', prompt: 'Opening', dialogue: 'Line one', duration: 1.25 },
    { title: 'Ending', prompt: 'Ending', duration: 1 },
  ], true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  for (const payload of buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [opening.id, ending.id])) {
    const job = store.addJob(project.id, 'comfy', payload);
    const [asset] = await store.addMedia(project.id, [{ src: footage, duration: 2, kind: 'video', origin: 'comfy', jobId: job.id }]);
    store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [asset.id] }) });
  }
  const data = () => store.project(project.id);
  const saved = voiceId => store.setShots(project.id, [{ ...opening, dialogue_audio_id: voiceId }, ending], true);
  assert.throws(() => saved(data().assets.find(asset => asset.kind === 'video').id), /当前项目的音频/);
  store.saveEditorDraft(project.id, 'shots', [{ ...opening, dialogue_audio_id: tooLong.id }]);
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === tooLong.id), false);
  await assert.rejects(store.appendStoryboard(project.id), /确认当前分镜/);
  saved(tooLong.id);
  await assert.rejects(store.appendStoryboard(project.id), /Opening.*请选择更短的配音/);
  assert.deepEqual(data().tracks, []);
  saved(voice.id);
  fs.unlinkSync(voice.path);
  await assert.rejects(store.appendStoryboard(project.id), /Opening.*配音缺失/);
  await services.relinkMedia(voice.id, audioFile);
  const music = store.addTrack(project.id, 'audio', 'Music');
  assert.equal((await store.appendStoryboard(project.id)).clips, 2);
  const tracks = () => data().tracks;
  const [first, last] = tracks().find(track => track.kind === 'video').clips;
  const voices = () => tracks().find(track => track.name === '台词配音').clips;
  const [initial] = voices();
  assert.equal(tracks().find(track => track.id === music.id).clips.length, 0);
  assert.equal(first.volume, 0);
  assert.equal(last.volume, 1);
  assert.deepEqual([initial.asset_id, initial.start, initial.duration, initial.linked_video_id], [voice.id, 0, 0.75, first.id]);
  const renderedAudio = async () => {
    const file = await media.exportVideo(data(), { fps: 24, preview: true });
    return ff('-i', file, '-vn', '-ac', '1', '-f', 's16le', '-');
  };
  const beforeSplit = await renderedAudio();
  assert.ok(beforeSplit.subarray(4000, 6000).some(value => value !== 0));
  store.updateClip(first.id, { in_point: 0.25 });
  assert.deepEqual([voices()[0].start, voices()[0].in_point, voices()[0].duration], [0, 0.25, 0.5]);
  assert.equal(tracks().find(track => track.kind === 'subtitle').clips[0].duration, 1.25);
  store.updateClip(first.id, { in_point: 0 });
  assert.deepEqual(voices(), [initial]);
  store.updateClip(first.id, { duration: 0.5 });
  assert.equal(voices()[0].duration, 0.5);
  store.updateClip(first.id, { duration: first.duration });
  assert.deepEqual(voices(), [initial]);
  store.updateClip(first.id, { in_point: 0.75 });
  assert.equal(voices().length, 0);
  assert.deepEqual(store.hiddenDialogue(project.id), [{ videoId: first.id, trackId: initial.track_id }]);
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === voice.id), false);
  assert.ok((await renderedAudio()).subarray(4000, 6000).every(value => value === 0));
  await store.init(directory);
  assert.equal(voices().length, 0);
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(voices(), [initial]);
  store.stepTimeline(project.id, 'redo');
  assert.equal(voices().length, 0);
  store.updateClip(first.id, { in_point: 0 });
  assert.deepEqual(voices(), [initial]);
  assert.deepEqual(await renderedAudio(), beforeSplit);
  store.updateClip(first.id, { in_point: 0.25, duration: 0.375 });
  const trimmedRight = store.splitClip(first.id, 0.125, 24);
  assert.deepEqual(voices().map(clip => [clip.in_point, clip.duration]), [[0.25, 0.125], [0.375, 0.25]]);
  store.updateClip(trimmedRight.id, { duration: 0.5 });
  assert.deepEqual(voices().map(clip => [clip.in_point, clip.duration]), [[0.25, 0.125], [0.375, 0.375]]);
  store.updateClip(first.id, { start: 2.5, in_point: 0, duration: 0.375 });
  assert.deepEqual(voices().map(clip => [clip.start, clip.in_point, clip.duration]), [[0.125, 0.375, 0.375], [2.5, 0, 0.375]]);
  for (let step = 0; step < 4; step++) store.stepTimeline(project.id, 'undo');
  assert.deepEqual(voices(), [initial]);
  const right = store.splitClip(first.id, 0.375, 24);
  assert.deepEqual(voices().map(clip => [clip.start, clip.in_point, clip.duration, clip.linked_video_id]),
    [[0, 0, 0.375, first.id], [0.375, 0.375, 0.375, right.id]]);
  assert.deepEqual(await renderedAudio(), beforeSplit);
  store.stepTimeline(project.id, 'undo');
  store.reorderClip(first.id, last.id, 'after');
  assert.equal(voices()[0].start, 1);
  store.updateClip(first.id, { start: 1.3, duration: 0.6 });
  assert.deepEqual([voices()[0].start, voices()[0].duration], [1.3, 0.6]);
  const newRight = store.splitClip(first.id, 1.5, 24);
  await store.init(directory);
  assert.equal(data().shots[0].dialogue_audio_id, voice.id);
  const rightVoice = voices().find(clip => clip.linked_video_id === newRight.id);
  assert.deepEqual([rightVoice.start, rightVoice.in_point, rightVoice.duration], [1.5, 0.2, 0.4]);
  store.updateClip(rightVoice.id, { volume: 0.5 });
  store.deleteClip(newRight.id);
  assert.equal(voices().length, 1);
  store.stepTimeline(project.id, 'undo');
  store.updateClip(rightVoice.id, { detachLink: true });
  store.updateClip(newRight.id, { start: 1.9 });
  const detached = voices().find(clip => clip.id === rightVoice.id);
  assert.deepEqual([detached.start, detached.volume, detached.linked_video_id], [1.5, 0.5, null]);
});

test('approved shots use independent reference images and only changed inputs invalidate their results', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Cast references', path.join(directory, 'project'), templates[0]);
  const add = async (name, kind = 'image', options) => {
    const src = path.join(directory, name);
    fs.writeFileSync(src, name);
    return (await store.addMedia(project.id, [{ src, kind, ...options }]))[0];
  };
  const hero = await add('hero.png');
  const supporting = await add('support.png');
  const fallback = await add('default.png');
  const unconfirmed = await add('unconfirmed.png');
  const video = await add('reference.mp4', 'video');
  const bundle = preset('drama', 'reference-video');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  store.saveInputs(project.id, 'drama', { referenceImage: fallback.id });
  const scenes = [
    { title: 'Hero', prompt: 'Hero enters', reference_image_id: hero.id },
    { title: 'Supporting', prompt: 'Supporting actor enters', reference_image_id: supporting.id },
    { title: 'Fallback', prompt: 'Cutaway' },
  ].map(shot => ({ ...shot, duration: 1 }));
  assert.throws(() => store.setShots(project.id, [{ ...scenes[0], reference_image_id: video.id }], true), /当前项目的图片/);
  const shots = store.setShots(project.id, scenes, true);
  const changed = { ...shots[0], reference_image_id: unconfirmed.id };
  store.saveProduction(project.id, { draftShots: [changed, ...shots.slice(1)] });
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === unconfirmed.id), false);
  store.saveProduction(project.id, { draftShots: null });
  assert.throws(() => store.saveEditorDraft(project.id, 'shots', [{ ...changed, reference_image_id: video.id }]), /当前项目的图片/);
  store.saveEditorDraft(project.id, 'shots', [changed]);
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === unconfirmed.id), false);
  await store.init(directory);
  const ids = shots.map(shot => shot.id);
  const generate = (selection = ids, workflow = bundle) =>
    buildGeneration(store.project(project.id), workflow, services.DEFAULT_COMFY, selection);
  assert.throws(generate, /确认或放弃/);
  assert.equal(store.project(project.id).editorDrafts.shots[0].reference_image_id, unconfirmed.id);
  store.saveProduction(project.id, { draftShots: null }, 'shots');
  assert.equal(store.assetCleanupPlan(project.id).assets.some(asset => asset.id === unconfirmed.id), true);
  assert.throws(() => generate(ids, preset('drama', 'video')), /Hero.*参考图工作流/);
  assert.equal(generate([shots[2].id], preset('drama', 'video'))[0].shotId, shots[2].id);
  const payloads = generate();
  assert.deepEqual(payloads.map(payload => payload.assetInputs.referenceImage), [hero.id, supporting.id, fallback.id]);
  const outputs = [];
  for (const [index, payload] of payloads.entries()) {
    const job = store.addJob(project.id, 'comfy', payload);
    const output = await add('clip-' + index + '.mp4', 'video', { duration: 1, origin: 'comfy', jobId: job.id });
    store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...payload, assets: [output.id] }) });
    outputs.push(output.id);
  }
  const choices = () => store.storyboardResults(project.id).shots;
  const candidateIds = () => choices().map(shot => shot.candidates.map(candidate => candidate.assetId));
  assert.deepEqual(candidateIds(), outputs.map(id => [id]));
  assert.equal((await store.appendStoryboard(project.id)).clips, 3);
  await store.relinkAsset(hero.id, unconfirmed.path, { kind: 'image' });
  assert.deepEqual(candidateIds(), [[], [outputs[1]], [outputs[2]]]);
  assert.equal(generate([shots[0].id])[0].assetRevisions.referenceImage, 1);
  fs.unlinkSync(supporting.path);
  assert.match(choices()[1].error, /镜头参考图缺失/);
  assert.deepEqual(candidateIds()[2], [outputs[2]]);
  assert.throws(generate, /Supporting.*参考图缺失/);
  await store.chooseShotResult(project.id, shots[2].id, outputs[2]);
});

test('timeline splitting and history keep both halves and linked captions atomic after reopening', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Timeline history', path.join(directory, 'project'), templates[0]);
  const fixture = path.join(directory, 'source.mp4');
  fs.writeFileSync(fixture, 'timeline edit fixture');
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [shot] = store.setShots(project.id, [{ prompt: 'Station', dialogue: 'Arrival', duration: 3 }], true);
  const [request] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id]);
  const job = store.addJob(project.id, 'comfy', request);
  const [asset] = await store.addMedia(project.id, [{ src: fixture, kind: 'video', duration: 4, origin: 'comfy', jobId: job.id }]);
  store.updateJob(job.id, { status: 'done', detail: JSON.stringify({ ...request, assets: [asset.id] }) });
  await store.appendStoryboard(project.id);
  const snapshot = () => store.project(project.id).tracks;
  const [video, captions] = snapshot();
  const [original] = video.clips;
  const [caption] = captions.clips;
  store.updateClip(original.id, { in_point: 0.25, transition: 'fade' });
  const before = snapshot();
  const history = () => store.timelineHistory(project.id, snapshot());
  assert.equal(history().undo, '修改片段');
  assert.throws(() => store.splitClip(original.id, 0.01, 24), /各保留 0.04/);
  assert.throws(() => store.splitClip(caption.id, 1.24, 24), /拆分关联的视频片段/);
  assert.deepEqual(snapshot(), before);

  const right = store.splitClip(original.id, 1.24, 24);
  assert.deepEqual([right.start, right.in_point, right.duration, right.split_duration], [1.25, 1.5, 1.75, 3]);
  const split = snapshot();
  assert.deepEqual(split[1].clips.map(clip => [clip.text, clip.start, clip.duration, clip.linked_video_id]),
    [['Arrival', 0, 1.25, original.id], ['Arrival', 1.25, 1.75, right.id]]);
  store.deleteTrack(project.id, video.id);
  assert.deepEqual(snapshot().map(track => track.clips.length), [0]);
  assert.equal(store.assetCleanupPlan(project.id).assets.some(item => item.id === asset.id), false);
  await store.init(directory);
  assert.equal(history().undo, '删除轨道');
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(snapshot(), split);
  assert.equal(history().redo, '删除轨道');
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(snapshot(), before);
  store.stepTimeline(project.id, 'redo');
  assert.deepEqual(snapshot(), split);
  store.updateClip(right.id, { volume: 0.5 });
  assert.equal(history().redo, null);
  assert.equal(snapshot()[0].clips[1].volume, 0.5);
});

test('replacing a storyboard version preserves edited clips and captions and can be undone as one edit', async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Replace a take', path.join(directory, 'project'), templates[0]);
  const bundle = preset('drama', 'video');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [main, other] = store.setShots(project.id, [
    { title: 'Arrival', prompt: 'The first take', duration: 1.25, dialogue: 'Hello' },
    { title: 'Cutaway', prompt: 'A cutaway', duration: 1 },
  ], true);
  async function generate(shotId, name, duration) {
    const source = path.join(directory, name);
    fs.writeFileSync(source, name);
    const [request] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shotId]);
    const job = store.addJob(project.id, 'comfy', request);
    const [asset] = await store.addMedia(project.id, [{ src: source, kind: 'video', origin: 'comfy', duration, jobId: job.id }]);
    const detail = JSON.stringify({ ...request, assets: [asset.id] });
    store.updateJob(job.id, { status: 'done', detail });
    return asset;
  }
  const original = await generate(main.id, 'original.mp4', 2);
  const cutaway = await generate(other.id, 'cutaway.mp4', 2);
  await store.appendStoryboard(project.id);
  const data = () => store.project(project.id);
  const initial = data().tracks[0].clips[0];
  store.updateClip(initial.id, { start: 0.1, in_point: 0.2, duration: 0.9, volume: 0.7, transition: 'fade' });
  const right = store.splitClip(initial.id, 0.5, 24);
  const subtitle = data().tracks.find(track => track.kind === 'subtitle').clips.find(clip => clip.linked_video_id === right.id);
  store.updateClip(subtitle.id, { text: 'An edited caption' });
  const overlay = store.addTrack(project.id, 'video', 'Overlay');
  const extra = store.addClip(overlay.id, { asset_id: original.id, start: 3, duration: 0.25 });
  const before = data().tracks;

  store.setShots(project.id, [{ ...main, prompt: 'An amended shot' }, other], true);
  const short = await generate(main.id, 'short.mp4', 0.65);
  const replacement = await generate(main.id, 'replacement.mp4', 1.75);
  const select = asset => store.replaceShotVersion(project.id, main.id, asset.id);
  const versions = store.storyboardResults(project.id).shots[0];
  assert.deepEqual(versions.timelineClipIds, [initial.id, right.id, extra.id]);
  assert.deepEqual(versions.candidates.map(item => item.assetId), [replacement.id, short.id]);
  await assert.rejects(select(cutaway), /所选版本已不可用/);
  await assert.rejects(select(short), /覆盖该剪辑范围/);
  await assert.rejects(store.replaceShotVersion(project.id, main.id, replacement.id, 'other-clip'), /没有可以替换/);
  store.saveEditorDraft(project.id, 'clip', { ...right, volume: 0.9 });
  await assert.rejects(select(replacement), /先保存或放弃/);
  store.saveEditorDraft(project.id, 'clip', null);
  const originalBytes = fs.readFileSync(replacement.path);
  fs.writeFileSync(replacement.path, 'manually replaced bytes');
  await assert.rejects(select(replacement), /素材内容已变更/);
  fs.writeFileSync(replacement.path, originalBytes);
  const concurrentAttempt = select(replacement);
  store.updateClip(right.id, { volume: 0.8 });
  await assert.rejects(concurrentAttempt, /剪辑点已变更/);
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(data().tracks, before);

  const switched = ids => before.map(track => ({ ...track, clips: track.clips.map(clip =>
    ids.includes(clip.id) ? { ...clip, asset_id: replacement.id } : clip) }));
  await store.chooseShotResult(project.id, main.id, short.id);
  assert.equal(await store.replaceShotVersion(project.id, main.id, replacement.id, right.id), 1);
  assert.deepEqual(data().tracks, switched([right.id]));
  assert.equal(await select(replacement), 2);
  assert.deepEqual(data().tracks, switched([initial.id, right.id, extra.id]));
  assert.equal(data().production.shotSelections[main.id], short.id);
  await store.init(directory);
  assert.equal(store.timelineHistory(project.id, data().tracks).undo, '替换镜头版本');
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(data().tracks, switched([right.id]));
  store.stepTimeline(project.id, 'undo');
  assert.deepEqual(data().tracks, before);
  store.stepTimeline(project.id, 'redo');
  store.stepTimeline(project.id, 'redo');
  assert.deepEqual(data().tracks, switched([initial.id, right.id, extra.id]));
});

test('a new sampler seed reaches ComfyUI without changing the saved workflow and is reused on retry', async t => {
  const root = makeFolder(t);
  await store.init(root);
  const project = store.createProject('Variation retry', path.join(root, 'project'), templates[0]);
  const [shot] = store.setShots(project.id, [{ prompt: 'Visit the station', duration: 1 }], true);
  const bundle = preset('drama', 'still');
  store.saveWorkflow(project.id, bundle.workflow, bundle.mapping);
  const [first] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id], true);
  assert.deepEqual(first.seedBinding, { node: '6', input: 'seed' });
  assert.ok(first.values.seed > 0);
  assert.equal(first.workflow['6'].inputs.seed, 0);
  const actualSeeds = [];
  t.mock.method(services, 'preflight', async () => {});
  t.mock.method(services, 'observeComfyProgress', () => () => {});
  t.mock.method(services, 'submitPrepared', async (url, prompt, { promptId }) => {
    actualSeeds.push(prompt['6'].inputs.seed);
    return { prompt_id: promptId };
  });
  t.mock.method(services, 'waitPrompt', async () => {
    if (actualSeeds.length === 1) throw new Error('model interrupted');
    return {};
  });
  t.mock.method(services, 'collect', async () => []);
  const jobs = createJobs(() => {});
  const original = jobs.start(project.id, 'comfy', first);
  await waitForJob(original.id, 'failed');
  const [next] = buildGeneration(store.project(project.id), bundle, services.DEFAULT_COMFY, [shot.id], true);
  assert.notEqual(next.values.seed, first.values.seed);
  const retry = jobs.retry(original.id);
  await waitForJob(retry.id, 'done');
  assert.deepEqual(actualSeeds, [first.values.seed, first.values.seed]);
  assert.deepEqual(store.loadWorkflow(project.id), { workflow: bundle.workflow, mapping: bundle.mapping });
  const wired = { ...bundle, mapping: { ...bundle.mapping, seed: first.seedBinding } };
  assert.equal(buildGeneration(store.project(project.id), wired, services.DEFAULT_COMFY, [shot.id])[0].values.seed, 0);
  const withAnotherSampler = { ...bundle, workflow: { ...bundle.workflow, extra: bundle.workflow['6'] } };
  assert.throws(() => buildGeneration(store.project(project.id), withAnotherSampler, services.DEFAULT_COMFY, [shot.id], true),
    /请在工作流映射中指定 seed/);
});

test('render queue supports cancellation and retry after relinking a missing asset', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Relink', path.join(directory, 'project'), templates[0]);
  const source = path.join(directory, 'source.mp4');
  const short = path.join(directory, 'short.mp4');
  ff('-f', 'lavfi', '-i', 'color=blue:s=32x32:d=1.5', '-c:v', 'libx264', source);
  ff('-f', 'lavfi', '-i', 'color=red:s=32x32:d=0.4', '-c:v', 'libx264', short);
  const [asset] = await store.addMedia(project.id, [{ src: source, ...await media.probe(source) }]);
  const track = store.addTrack(project.id, 'video', 'Video');
  store.addClip(track.id, { asset_id: asset.id, in_point: 0.2, duration: 1 });
  fs.unlinkSync(asset.path);
  const snapshot = store.project(project.id);
  const jobs = createJobs(() => {});
  const failed = jobs.start(project.id, 'export', { snapshot });
  const waiting = jobs.start(project.id, 'preview', { snapshot });
  assert.equal(failed.status, 'rendering');
  assert.equal(waiting.status, 'queued');
  assert.equal((await jobs.cancel(waiting.id)).status, 'cancelled');
  await waitForJob(failed.id, 'failed');
  const shorter = await media.probe(short);
  await assert.rejects(store.relinkAsset(asset.id, short, shorter), /替换素材时长不足/);
  await store.relinkAsset(asset.id, source, await media.probe(source));
  const restored = store.assets(project.id)[0];
  assert.equal(path.dirname(restored.path), path.join(project.dir, 'assets'));
  assert.equal(restored.revision, 0, 'relinking the original bytes should retain the failed render snapshot revision');
  const retry = await jobs.retry(failed.id);
  const result = await waitForJob(retry.id, 'done');
  const file = JSON.parse(result.detail).file;
  assert.equal((await media.probe(file)).duration, 1);
  assert.equal(JSON.parse(result.detail).snapshot.assets[0].path, restored.path);

  const green = path.join(directory, 'green.mp4');
  ff('-f', 'lavfi', '-i', 'color=green:s=32x32:d=1.5', '-c:v', 'libx264', green);
  await store.relinkAsset(asset.id, green, await media.probe(green));
  const latest = store.assets(project.id)[0];
  fs.unlinkSync(file);
  const exact = await jobs.retry(result.id);
  const exactRender = JSON.parse((await waitForJob(exact.id, 'done')).detail);
  assert.equal(exactRender.snapshot.assets[0].path, restored.path);
  const centerPixel = file => ff('-i', file, '-vf', 'crop=2:2', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-');
  assert.ok(centerPixel(exactRender.file)[2] > 200, 're-export should use the historical blue source');

  fs.unlinkSync(restored.path);
  const count = store.project(project.id).jobs.length;
  const proposed = await jobs.retry(result.id);
  assert.deepEqual(proposed.replacements, [{ id: asset.id, name: restored.name, revision: latest.revision }]);
  const stale = [{ ...proposed.replacements[0], revision: restored.revision }];
  assert.deepEqual(await jobs.retry(result.id, undefined, stale), proposed);
  assert.equal(store.project(project.id).jobs.length, count);
  const revised = await jobs.retry(result.id, undefined, proposed.replacements);
  const revisedRender = JSON.parse((await waitForJob(revised.id, 'done')).detail);
  assert.equal(revisedRender.snapshot.assets[0].path, latest.path);
  const [r, g, b] = centerPixel(revisedRender.file);
  assert.ok(r < 10 && g > 100 && b < 10, 're-export should use green after explicit replacement');
});

test('a same-path overwrite requires relinking and approval before any replacement export', { skip: !hasFFmpeg }, async t => {
  const dir = makeFolder(t);
  await store.init(dir);
  const project = store.createProject('Overwrite', path.join(dir, 'project'), templates[2]);
  const source = path.join(dir, 'original.mp4');
  const replacement = path.join(dir, 'replacement.mp4');
  for (const [color, file] of [['red', source], ['blue', replacement]]) {
    ff('-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=1`, '-c:v', 'libx264', file);
  }
  const [asset] = await store.addMedia(project.id, [
    { src: source, ...await media.probe(source), origin: 'comfy' },
  ]);
  store.approveEnhancement(project.id, asset.id, 0);
  const track = store.addTrack(project.id, 'video', '画质增强');
  store.addClip(track.id, { asset_id: asset.id });
  const snapshot = store.project(project.id);
  const jobs = createJobs(() => {});
  const original = jobs.start(project.id, 'export', { snapshot });
  const output = JSON.parse((await waitForJob(original.id, 'done')).detail).file;
  fs.unlinkSync(output);
  fs.copyFileSync(replacement, asset.path);
  await assert.rejects(jobs.retry(original.id), /素材内容已变更.*重新定位/);
  await assert.rejects(media.exportVideo(snapshot), /素材内容已变更/);

  await store.relinkAsset(asset.id, asset.path, await media.probe(asset.path));
  await assert.rejects(jobs.retry(original.id), /确认增强结果/);
  store.approveEnhancement(project.id, asset.id, 1);
  const { replacements } = await jobs.retry(original.id);
  assert.deepEqual(replacements, [{ id: asset.id, name: asset.name, revision: 1 }]);
  const retried = await jobs.retry(original.id, undefined, replacements);
  const result = JSON.parse((await waitForJob(retried.id, 'done')).detail);
  const pixels = ff('-i', result.file, '-vf', 'crop=2:2', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-');
  assert.ok(pixels[2] > 240 && pixels[0] < 20);

  const renderPath = path.join(dir, 'changed-during-render.mp4');
  let overwritten = false;
  await assert.rejects(media.exportVideo(store.project(project.id), {
    output: renderPath, onProgress: progress => {
      if (progress < 0.9 || overwritten) return;
      fs.copyFileSync(source, asset.path);
      overwritten = true;
    },
  }), /素材内容已变更/);
  assert.equal(fs.existsSync(renderPath), false);
});

test('obsolete previews cannot displace the current preview and retries use current edits', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Current preview', path.join(directory, 'project'), templates[0]);
  const track = store.addTrack(project.id, 'subtitle', 'Captions');
  const caption = store.addClip(track.id, { text: 'Current caption', duration: 0.5 });
  const settings = { format: 'square', resolution: 720, fps: 24 };
  store.saveProduction(project.id, { exportSettings: settings });
  const payload = () => ({ ...settings, snapshot: createRenderSnapshot(store.project(project.id)) });
  const fileFor = job => path.join(project.dir, '.preview', job.id + '.mp4');
  const jobs = createJobs(() => {});

  const first = jobs.start(project.id, 'preview', payload());
  const original = await waitForJob(first.id, 'done');
  assert.equal(JSON.parse(original.detail).file, fileFor(first));
  store.updateClip(caption.id, { text: 'Temporary caption' });
  const previousEdit = payload();
  let release;
  let rendering;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { rendering = resolve; });
  t.mock.method(services, 'exportVideo', async (snapshot, options) => {
    if (snapshot.tracks[0].clips[0].text === 'Temporary caption') {
      rendering();
      await waiting;
    }
    return media.exportVideo(snapshot, options);
  });
  const obsolete = jobs.start(project.id, 'preview', previousEdit);
  try {
    await started;
    store.updateClip(caption.id, { text: 'Current caption' });
  } finally { release(); }
  const interrupted = await waitForJob(obsolete.id, 'interrupted');
  assert.match(JSON.parse(interrupted.detail).error, /时间线或预览设置已更新/);
  assert.ok(fs.existsSync(fileFor(first)));

  const recoverObsolete = store.addJob(project.id, 'preview', previousEdit);
  const recoverMatching = store.addJob(project.id, 'preview', payload());
  for (const record of [recoverObsolete, recoverMatching]) {
    const { snapshot } = JSON.parse(record.detail);
    await media.exportVideo(snapshot, { ...settings, preview: true, output: fileFor(record) });
    store.updateJob(record.id, { status: 'rendering' });
  }
  const retry = jobs.retry(obsolete.id);
  const refreshed = JSON.parse((await waitForJob(retry.id, 'done')).detail);
  assert.equal(refreshed.snapshot.tracks[0].clips[0].text, 'Current caption');
  assert.equal(refreshed.file, fileFor(retry));
  assert.equal(refreshed.fps, 24);
  jobs.stop();

  await store.init(directory);
  createJobs(() => {}).recover();
  await waitForJob(recoverObsolete.id, 'interrupted');
  await waitForJob(recoverMatching.id, 'done');
  for (let attempt = 0; attempt < 50 && [obsolete, first, recoverObsolete, recoverMatching].some(job => fs.existsSync(fileFor(job))); attempt++) {
    await delay(20);
  }
  for (const job of [obsolete, first, recoverObsolete, recoverMatching]) assert.equal(fs.existsSync(fileFor(job)), false);
  assert.ok(fs.existsSync(refreshed.file));
});

test('a forced desktop exit stops FFmpeg and removes unpublished render files', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const temp = path.join(directory, 'temp');
  const output = path.join(directory, 'exports', 'interrupted.mp4');
  const partial = output + '.partial.mp4';
  const pidFile = path.join(directory, 'ffmpeg.pid');
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(directory, 'record-ffmpeg.cjs'), `
    const fs = require('node:fs');
    const processes = require('node:child_process');
    const spawn = processes.spawn;
    processes.spawn = (binary, args, options) => {
      const child = spawn(binary, args, options);
      if (args.includes('-filter_complex_script')) fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      return child;
    };
  `);
  const owner = spawn(process.execPath, ['-e', `
    const snapshot = { dir: process.argv[2], assets: [], tracks: [{ kind: 'subtitle', clips: [
      { start: 0, in_point: 0, duration: 1200, volume: 1, text: 'Forced exit', transition: 'none' },
    ] }] };
    require(process.argv[1]).exportVideo(snapshot, { output: process.argv[3] })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  `, require.resolve('../electron/services.cjs'), directory, output], {
    cwd: directory, stdio: 'ignore',
    env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp, NODE_OPTIONS: '--require ./record-ffmpeg.cjs' },
  });
  let pid;
  t.after(() => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
  const deadline = Date.now() + 6000;
  while (!(fs.existsSync(pidFile) && fs.existsSync(partial)) && Date.now() < deadline) await delay(20);
  assert.equal(fs.existsSync(partial), true, 'Wait for the live FFmpeg process to create the partial file');
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1);
  const closed = once(owner, 'close');
  assert.equal(owner.kill('SIGKILL'), true);
  await closed;
  const stopped = () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  const cleanupDeadline = Date.now() + 5000;
  while ((!stopped() || fs.existsSync(partial) || fs.readdirSync(temp).length) && Date.now() < cleanupDeadline) await delay(30);
  assert.equal(stopped(), true, 'FFmpeg must stop when the application exits');
  pid = undefined;
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(partial), false);
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('recovery restores an atomically published render and keeps a partial render interrupted', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Render recovery', path.join(directory, 'project'), templates[0]);
  const captions = store.addTrack(project.id, 'subtitle', '字幕');
  store.addClip(captions.id, { text: 'Completed render', duration: 1 });
  const snapshot = store.project(project.id);
  const completed = store.addJob(project.id, 'export', { snapshot });
  const partial = store.addJob(project.id, 'export', { snapshot });
  const destination = path.join(project.dir, 'exports', `iModuReel-${completed.id}.mp4`);
  await media.exportVideo(snapshot, { output: destination, format: 'portrait' });
  const partialFile = path.join(project.dir, 'exports', `iModuReel-${partial.id}.mp4.partial.mp4`);
  fs.writeFileSync(partialFile, 'unfinished file');
  for (const job of [completed, partial]) store.updateJob(job.id, { status: 'rendering' });
  const database = path.join(directory, 'imodureel.sqlite');
  const originalFile = fs.statSync(destination, { bigint: true });
  const open = fs.openSync;
  let diskFull = true;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (diskFull && file === database + '.tmp') throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return open(file, ...args);
  });
  await store.init(directory);
  const jobs = createJobs(() => {});
  jobs.recover();
  for (const job of [completed, partial]) {
    assert.equal((await waitForStorageIssue(jobs, job.id)).canCancel, false);
    await assert.rejects(jobs.cancel(job.id), /任务正在恢复/);
    assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [job.id]).status, 'rendering');
  }
  diskFull = false;
  jobs.resume(completed.id);
  jobs.resume(partial.id);
  await waitForJob(completed.id, 'done');
  await waitForJob(partial.id, 'interrupted');
  assert.equal(fs.statSync(destination, { bigint: true }).mtimeNs, originalFile.mtimeNs);
  const recovered = store.project(project.id);
  const published = recovered.jobs.find(job => job.id === completed.id);
  assert.equal(published.status, 'done');
  assert.equal(JSON.parse(published.detail).file, destination);
  assert.deepEqual(await media.probe(destination).then(({ duration, width, height }) => [duration, width, height]), [1, 720, 1280]);
  const interrupted = recovered.jobs.find(job => job.id === partial.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(JSON.parse(interrupted.detail).file, undefined);
});

test('storage pressure preserves a published MP4 and pauses later renders until they can resume', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const project = store.createProject('Disk pressure', path.join(directory, 'project'), templates[0]);
  const track = store.addTrack(project.id, 'subtitle', 'Captions');
  store.addClip(track.id, { text: 'Keep the completed cut', duration: 0.5 });
  const snapshot = store.project(project.id);
  const database = path.join(directory, 'imodureel.sqlite');
  let published;
  let databaseFull = true;
  let temporaryFull = false;
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (databaseFull && destination === database && published && fs.existsSync(published)) {
      throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    }
    return renameSync(source, destination);
  });
  const writeFile = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', (file, ...args) => {
    if (temporaryFull && path.basename(file) === 'filters.txt' && path.dirname(file).includes('imodureel-render-')) {
      return Promise.reject(Object.assign(new Error('Disk quota'), { code: 'EDQUOT' }));
    }
    return writeFile(file, ...args);
  });
  t.mock.method(services, 'exportVideo', media.exportVideo);
  const jobs = createJobs(() => {});
  const exported = jobs.start(project.id, 'export', { snapshot });
  const preview = jobs.start(project.id, 'preview', { snapshot });
  published = path.join(project.dir, 'exports', `iModuReel-${exported.id}.mp4`);
  const issue = await waitForStorageIssue(jobs, exported.id);
  assert.equal(issue.canCancel, false);
  assert.match(issue.message, /磁盘空间不足/);
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [preview.id]).status, 'queued');
  assert.equal(store.one('SELECT status FROM jobs WHERE id = ?', [exported.id]).status, 'rendering');
  assert.equal(fs.existsSync(database + '.tmp'), false);
  const stamp = fs.statSync(published, { bigint: true });
  assert.equal((await media.probe(published)).duration, 0.5);
  await assert.rejects(jobs.cancel(exported.id), /产物已生成/);
  jobs.resume(exported.id);
  await waitForStorageIssue(jobs, exported.id);
  temporaryFull = true;
  databaseFull = false;
  jobs.resume(exported.id);
  assert.equal(JSON.parse((await waitForJob(exported.id, 'done')).detail).file, published);
  assert.equal(fs.statSync(published, { bigint: true }).mtimeNs, stamp.mtimeNs);
  assert.equal(store.project(project.id).jobs.length, 2);
  assert.equal((await waitForStorageIssue(jobs, preview.id)).canCancel, true);
  temporaryFull = false;
  jobs.resume(preview.id);
  const previewFile = JSON.parse((await waitForJob(preview.id, 'done')).detail).file;
  assert.equal((await media.probe(previewFile)).duration, 0.5);
  assert.equal(jobs.storageIssue(preview.id), undefined);
  await store.init(directory);
  assert.ok(store.project(project.id).jobs.every(job => job.status === 'done'));
});

test('trimmed video and a delayed audio clip mix at their timeline positions', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const movie = path.join(directory, 'video.mp4');
  const music = path.join(directory, 'music.wav');
  const cover = path.join(directory, 'cover.jpg');
  const album = path.join(directory, 'album.mp3');
  ff('-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=440:d=2',
    '-c:v', 'libx264', '-c:a', 'aac', movie);
  ff('-f', 'lavfi', '-i', 'sine=880:d=2', music);
  ff('-f', 'lavfi', '-i', 'color=blue:s=32x32', '-frames:v', '1', cover);
  ff('-i', music, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy',
    '-disposition:v', 'attached_pic', album);
  assert.equal((await media.probe(album)).kind, 'audio');

  const result = await media.exportVideo({
    dir: directory,
    assets: [{ id: 'video', kind: 'video', path: movie }, { id: 'audio', kind: 'audio', path: album }],
    tracks: [
      { kind: 'video', clips: [{ asset_id: 'video', in_point: 0.25, start: 0.5, duration: 1, volume: 1 }] },
      { kind: 'audio', clips: [{ asset_id: 'audio', in_point: 0, start: 1, duration: 1, volume: 1 }] },
    ],
  }, { format: 'portrait', preview: true });
  const info = await media.probe(result);
  assert.deepEqual([info.width, info.height, info.duration, info.audio], [360, 640, 2, true]);
  const pcm = ff('-i', result, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-');
  function amplitude(seconds, frequency) {
    let sine = 0;
    let cosine = 0;
    const offset = Math.round(seconds * 48000);
    const length = 4800;
    for (let index = 0; index < length; index++) {
      const sample = pcm.readInt16LE((offset + index) * 2) / 32768;
      const phase = 2 * Math.PI * frequency * index / 48000;
      sine += sample * Math.sin(phase);
      cosine += sample * Math.cos(phase);
    }
    return 2 * Math.hypot(sine, cosine) / length;
  }
  assert.ok(amplitude(0.2, 440) < 0.01 && amplitude(0.2, 880) < 0.01);
  assert.ok(amplitude(0.7, 440) > 0.06 && amplitude(0.7, 880) < 0.01);
  assert.ok(amplitude(1.1, 440) > 0.06 && amplitude(1.1, 880) > 0.06);
  assert.ok(amplitude(1.7, 440) < 0.01 && amplitude(1.7, 880) > 0.06);
});

test('splitting mixed frame rates retains the original pictures, sound and fade clock', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  await store.init(directory);
  const source = path.join(directory, 'motion.mkv');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=443:sample_rate=48000:duration=2', '-c:v', 'libx264', '-c:a', 'pcm_s16le', source);
  const project = store.createProject('Motion cut', path.join(directory, 'project'), templates[0]);
  const [asset] = await store.addMedia(project.id, [{ src: source, ...await media.probe(source) }]);
  const track = store.addTrack(project.id, 'video', 'Video');
  const render = name => media.exportVideo(store.project(project.id), { fps: 24, output: path.join(directory, name + '.mp4') });
  const mono = file => ff('-i', file, '-vn', '-ar', '48000', '-ac', '1', '-f', 's16le', '-');
  const luma = file => ff('-i', file, '-an', '-vf', 'scale=48:28,format=gray', '-f', 'rawvideo', '-');
  const energy = (data, at) => {
    const start = Math.round(at * 48000);
    let square = 0;
    for (let index = 0; index < 240; index++) square += data.readInt16LE((start + index) * 2) ** 2;
    return Math.sqrt(square / 240);
  };
  for (const [index, input] of [
    { start: 0, in_point: 0 }, { start: 0.019, in_point: 0.023 },
  ].entries()) {
    const clip = store.addClip(track.id, { ...input, asset_id: asset.id, duration: 1.5, transition: 'fade' });
    const before = await render('before-' + index);
    const right = store.splitClip(clip.id, 13 / 24, 24);
    store.splitClip(right.id, 31 / 24, 24);
    const after = await render('after-' + index);
    const [beforePixels, afterPixels] = [luma(before), luma(after)];
    assert.equal(afterPixels.length, beforePixels.length);
    const frameSize = 48 * 28;
    for (let offset = 0; offset < beforePixels.length; offset += frameSize) {
      const diff = beforePixels.subarray(offset, offset + frameSize).reduce((sum, value, pixel) =>
        sum + Math.abs(value - afterPixels[offset + pixel]), 0);
      assert.ok(diff / frameSize < 0.8, `picture changed at frame ${offset / frameSize}`);
    }
    const [beforeAudio, afterAudio] = [mono(before), mono(after)];
    for (const time of [0.1, 0.533, 0.548, 0.9, 1.285, 1.3, 1.42]) {
      const levels = [energy(beforeAudio, time), energy(afterAudio, time)];
      assert.ok(Math.abs(levels[0] - levels[1]) < 0.12 * levels[0], `audio changed at ${time} s: ${levels}`);
    }
    for (const piece of store.project(project.id).tracks[0].clips) store.deleteClip(piece.id);
  }
});

test('visual clips shorter than a frame are visible at the first output timestamp after their start', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const still = path.join(directory, 'red.png');
  const motion = path.join(directory, 'blue.mp4');
  ff('-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', still);
  ff('-f', 'lavfi', '-i', 'color=blue:s=64x64:r=25:d=1', '-c:v', 'libx264', motion);
  const clip = { in_point: 0, duration: 0.04, volume: 1 };
  const project = {
    dir: directory, assets: [{ id: 'still', kind: 'image', path: still }, { id: 'motion', kind: 'video', path: motion }],
    tracks: [
      { kind: 'video', clips: [
        { ...clip, asset_id: 'still', start: 1.01, transition: 'fade' },
        { ...clip, asset_id: 'motion', start: 2.01 },
      ] },
      { kind: 'subtitle', clips: [{ ...clip, start: 0.01, text: 'Short title' }] },
    ],
  };
  for (const { fps, preview } of [{ fps: 24, preview: true }, { fps: 30, preview: false }]) {
    const output = await media.exportVideo(project, { format: 'square', fps, preview });
    const colors = ff('-i', output, '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-');
    const color = frame => [...colors.subarray(frame * 3, frame * 3 + 3)];
    assert.ok(color(fps + 1)[0] > 240, 'the short still should be displayed');
    assert.ok(color(fps * 2 + 1)[2] > 240, 'the short video should be displayed at its final frame position');
    for (const frame of [fps, fps + 2, fps * 2]) assert.deepEqual(color(frame), [0, 0, 0]);
    const glyph = ff('-i', output, '-vf', "select='eq(n,1)',format=gray", '-frames:v', '1', '-f', 'rawvideo', '-');
    assert.ok(glyph.some(value => value > 180), 'the caption must be visible in its frame');
  }
});

test('rendering a cut between source frames keeps the active picture and preserves stream delays', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const source = path.join(directory, 'low-fps.mp4');
  const delayed = path.join(directory, 'delayed-video.mp4');
  const trailingAudio = path.join(directory, 'trailing-audio.mp4');
  const background = path.join(directory, 'background.png');
  const silence = path.join(directory, 'silence.wav');
  ff('-f', 'lavfi', '-i', 'color=red:s=160x90:r=1:d=3', '-f', 'lavfi', '-i', 'sine=440:sample_rate=48000:d=3',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'", '-c:v', 'libx264', '-g', '1', '-c:a', 'aac', source);
  ff('-itsoffset', '0.6', '-i', source, '-i', source, '-map', '0:v', '-map', '1:a', '-c', 'copy', delayed);
  ff('-f', 'lavfi', '-i', 'color=red:s=160x90:r=1:d=1', '-i', source, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'copy', trailingAudio);
  ff('-f', 'lavfi', '-i', 'color=lime:s=160x90', '-frames:v', '1', background);
  ff('-f', 'lavfi', '-i', 'anullsrc=r=48000', '-t', '0.1', silence);

  const assets = [
    { id: 'source', kind: 'video', path: source },
    { id: 'delayed', kind: 'video', path: delayed },
    { id: 'ending', kind: 'video', path: trailingAudio },
    { id: 'background', kind: 'image', path: background },
    { id: 'silence', kind: 'audio', path: silence },
  ];
  const clip = { asset_id: 'source', start: 0, in_point: 0.45, duration: 0.3, volume: 1 };
  const video = clips => ({ kind: 'video', clips });
  const pixels = file => ff('-i', file, '-vf', 'format=rgb24,crop=1:1:iw/2:ih/2', '-f', 'rawvideo', '-');
  const color = (pixels, frame) => [...pixels.subarray(frame * 3, frame * 3 + 3)];
  const red = ([r, g, b]) => r > 215 && g < 40 && b < 40;
  const blue = ([r, g, b]) => b > 215 && g < 40 && r < 40;
  const green = ([r, g, b]) => g > 215 && r < 40 && b < 40;
  for (const preview of [true, false]) {
    const fps = preview ? 30 : 60;
    const short = await media.exportVideo({ dir: directory, assets, tracks: [video([clip])] }, { preview, fps });
    const shortPixels = pixels(short);
    assert.equal(shortPixels.length / 3, 0.3 * fps);
    assert.ok(red(color(shortPixels, 0)) && red(color(shortPixels, 0.3 * fps - 1)));
    const pcm = ff('-i', short, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-');
    assert.ok(Array.from({ length: 200 }, (_, index) => Math.abs(pcm.readInt16LE((2400 + index) * 2))).some(sample => sample > 1000));

    const next = await media.exportVideo({ dir: directory, assets, tracks: [video([{ ...clip, duration: 1 }])] }, { preview, fps });
    const nextPixels = pixels(next);
    const blueFrame = Math.ceil(0.55 * fps);
    assert.ok(red(color(nextPixels, blueFrame - 1)) && blue(color(nextPixels, blueFrame)));
  }
  const mixed = await media.exportVideo({ dir: directory, assets, tracks: [
    video([{ ...clip, asset_id: 'background', in_point: 0, duration: 0.8 }]),
    video([{ ...clip, asset_id: 'delayed', in_point: 0.2, duration: 0.8 }]),
  ] }, { preview: true });
  const mixedPixels = pixels(mixed);
  assert.ok(green(color(mixedPixels, 6)), 'an authentic picture delay should leave the lower track visible');
  assert.ok(red(color(mixedPixels, 16)));
  const tail = await media.exportVideo({ dir: directory, assets, tracks: [
    video([{ ...clip, asset_id: 'background', in_point: 0 }]),
    video([{ ...clip, asset_id: 'ending', in_point: 1.2 }]),
  ] }, { preview: true });
  const tailPixels = pixels(tail);
  assert.ok(green(color(tailPixels, 0)) && green(color(tailPixels, 8)), 'a cut into an audio-only tail must not restore an expired frame');

  const segmented = await media.exportVideo({ dir: directory, assets, tracks: [
    video([{ ...clip, duration: 1 }]),
    { kind: 'audio', clips: Array.from({ length: 22 }, (_, index) => ({
      ...clip, asset_id: 'silence', in_point: 0, start: index / 40, duration: 0.05,
    })) },
  ] }, { preview: true });
  const segmentedPixels = pixels(segmented);
  assert.equal(segmentedPixels.length / 3, 30);
  assert.ok([0, 12, 13, 16].every(frame => red(color(segmentedPixels, frame))));
  assert.ok([17, 18, 29].every(frame => blue(color(segmentedPixels, frame))));
});

test('late MP4 cuts seek on the original time base and fall back if a sparse keyframe is past the cut', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const late = path.join(directory, 'late.mp4');
  const sparse = path.join(directory, 'sparse.mp4');
  const tone = 'sine=frequency=505:sample_rate=44100:duration=14';
  ff('-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=25:d=13', '-itsoffset', '0.407123', '-f', 'lavfi', '-i', tone,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-g', '100', '-c:a', 'alac', '-output_ts_offset', '19', late);
  ff('-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=10:d=14', '-f', 'lavfi', '-i', tone, '-map', '0:v', '-map', '1:a',
    '-vf', "select='eq(n,0)+eq(n,15)+eq(n,94)+gte(n,123)'", '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-g', '2', '-c:a', 'alac', sparse);
  const assets = [{ id: 'late', path: late, kind: 'video' }, { id: 'sparse', path: sparse, kind: 'video' }];
  const project = { dir: directory, assets, tracks: [{ kind: 'video', clips: [
    { asset_id: 'late', start: 0.137, in_point: 8.721, duration: 0.9, transition: 'fade', volume: 0.8 },
    { asset_id: 'sparse', start: 1.071, in_point: 7.67, duration: 0.75, volume: 1 },
  ] }] };

  const childProcess = require('node:child_process');
  const nativeSpawn = childProcess.spawn;
  const optionedInputs = [];
  let seekEnabled = true;
  t.after(() => { childProcess.spawn = nativeSpawn; });
  childProcess.spawn = (file, args, options) => {
    if (!args.includes('-filter_complex_script')) return nativeSpawn(file, args, options);
    const command = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '-ss' && args[index + 2] === '-noaccurate_seek' && args[index + 3] === '-itsoffset') {
        if (seekEnabled) optionedInputs.push(args[index + 6]);
        else {
          index += 4;
          continue;
        }
      }
      command.push(args[index]);
    }
    return nativeSpawn(file, command, options);
  };
  const optimized = await media.exportVideo(project, { preview: true, fps: 24 });
  assert.deepEqual(optionedInputs, [late]);
  seekEnabled = false;
  const unseeked = await media.exportVideo(project, { preview: true, fps: 24 });
  childProcess.spawn = nativeSpawn;
  const pictures = file => ff('-i', file, '-map', '0:v:0', '-f', 'framemd5', '-');
  const sound = file => ff('-i', file, '-map', '0:a:0', '-f', 's16le', '-');
  assert.deepEqual(pictures(optimized), pictures(unseeked));
  assert.deepEqual(sound(optimized), sound(unseeked));
});

test('exports retain a source audio delay and render supported stills and all subtitle lines', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const source = path.join(directory, 'delayed-av.mp4');
  const still = path.join(directory, 'still.avif');
  ff('-f', 'lavfi', '-i', 'color=red:s=80x80:r=30:d=1', '-itsoffset', '0.5', '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=48000:duration=0.4',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', source);
  ff('-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', still);
  assert.equal((await media.probe(still)).kind, 'image');
  const captions = Array(8).fill('CAPTION').join('\n');
  const clip = { start: 0, in_point: 0, duration: 1, volume: 1 };
  const tracks = [
    { kind: 'video', clips: [{ ...clip, asset_id: 'source' }, { ...clip, asset_id: 'still', start: 1 }] },
    { kind: 'subtitle', clips: [{ ...clip, start: 1, text: captions + '\nLAST LINE' }] },
  ];
  const assets = [{ id: 'source', kind: 'video', path: source }, { id: 'still', kind: 'image', path: still }];
  const original = await media.exportVideo({ dir: directory, assets, tracks }, { preview: true });
  const pcm = ff('-i', original, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-');
  function peak(start) {
    const offset = Math.round(start * 48000);
    let value = 0;
    for (let sample = offset; sample < offset + 1200; sample++) {
      value = Math.max(value, Math.abs(pcm.readInt16LE(sample * 2)));
    }
    return value;
  }
  assert.ok(peak(0.1) < 50);
  assert.ok(peak(0.55) > 1000);

  const pixel = ff('-ss', '1.75', '-i', original, '-vf', 'format=rgb24,crop=1:1:320:180', '-frames:v', '1', '-f', 'rawvideo', '-');
  assert.ok(pixel[0] < 30 && pixel[1] < 30 && pixel[2] > 200);
  tracks[1].clips[0].text = captions + '\nDIFFERENT';
  const changed = await media.exportVideo({ dir: directory, assets, tracks }, { preview: true });
  const frame = file => ff('-ss', '1.75', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-');
  assert.notDeepEqual(frame(changed), frame(original), 'Changing line nine should change the second subtitle page');
});

test('a render with many sequential clips preserves frames, fades, audio and captions across joins', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const red = path.join(directory, 'red.png');
  const blue = path.join(directory, 'blue.png');
  const green = path.join(directory, 'green.png');
  const tone = path.join(directory, 'music.wav');
  for (const [file, color] of [[red, 'red'], [blue, 'blue'], [green, 'lime']]) {
    ff('-f', 'lavfi', '-i', `color=${color}:s=160x90`, '-frames:v', '1', file);
  }
  ff('-f', 'lavfi', '-i', 'sine=frequency=750:sample_rate=48000:duration=4', tone);
  const clip = { in_point: 0, volume: 1 };
  const progress = [];
  const project = {
    dir: directory,
    assets: [
      { id: 'red', kind: 'image', path: red }, { id: 'blue', kind: 'image', path: blue },
      { id: 'green', kind: 'image', path: green }, { id: 'music', kind: 'audio', path: tone },
    ],
    tracks: [
      { kind: 'video', clips: Array.from({ length: 48 }, (_, index) => ({
        ...clip, asset_id: index % 2 ? 'red' : 'blue', start: index / 10, duration: 0.1,
      })) },
      { kind: 'video', clips: [{ ...clip, asset_id: 'green', start: 1.28, duration: 1.14, transition: 'fade' }] },
      { kind: 'audio', clips: [{ ...clip, asset_id: 'music', start: 0.35, duration: 4 }] },
      { kind: 'subtitle', clips: [{ ...clip, start: 1.29, duration: 1.5, text: '跨段字幕' }] },
    ],
  };
  const result = await media.exportVideo(project, { preview: true, onProgress: value => progress.push(value) });
  const info = await media.probe(result);
  assert.deepEqual([info.duration, info.fps], [4.8, 30]);
  assert.equal(await media.countVideoFrames(result), 144);
  assert.ok(progress.length >= 4 && progress.at(-1) === 1 && progress.every((point, i) => !i || point > progress[i - 1]));
  const frames = ff('-i', result, '-vf', 'format=rgb24,crop=1:1:320:120', '-f', 'rawvideo', '-');
  const colors = frame => [...frames.subarray(frame * 3, frame * 3 + 3)];
  assert.ok(colors(1)[2] > 240 && colors(4)[0] > 240);
  const joinFrames = [47, 48, 49, 50].map(frame => colors(frame)[1]);
  assert.ok(joinFrames[0] > 170 && joinFrames.at(-1) > 240 &&
    joinFrames.slice(1).every((level, index) => level > joinFrames[index]),
  `the fade must continue across the first join: ${JSON.stringify(joinFrames)}`);
  assert.ok(colors(142)[0] > 240);
  const subtitle = time => ff('-ss', String(time), '-i', result, '-frames:v', '1', '-vf',
    'format=gray,crop=240:75:200:275', '-f', 'rawvideo', '-');
  assert.ok(subtitle(1.50).some(pixel => pixel > 220) && subtitle(1.67).some(pixel => pixel > 220));
  const pcm = ff('-i', result, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-');
  assert.ok(Math.abs(pcm.length / 2 / 48000 - 4.8) < 0.025);
  const rms = (begin, end) => {
    let energy = 0;
    for (let sample = begin; sample < end; sample++) energy += pcm.readInt16LE(sample * 2) ** 2;
    return Math.sqrt(energy / (end - begin));
  };
  assert.ok(rms(0, 1200) < 20 && rms(215000, 216000) < 20);
  for (const side of [1.58, 1.60, 3.14, 3.16]) {
    const sample = Math.round(side * 48000);
    assert.ok(rms(sample, sample + 96) > 1500, 'audio must continue on both sides of a join');
  }
  const cinema = await media.exportVideo(project, { preview: true, fps: 24 });
  const cinemaInfo = await media.probe(cinema);
  assert.deepEqual([cinemaInfo.fps, cinemaInfo.audio], [24, true]);
  assert.ok(Math.abs(cinemaInfo.duration - 4.8) < 1 / 24);
  assert.equal(await media.countVideoFrames(cinema), Math.ceil(4.8 * 24), 'the last visible output frame is part of the cut');
});

test('preview reuses unchanged segments after an edit and rebuilds a damaged cache entry', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const red = path.join(directory, 'red.png');
  const blu = path.join(directory, 'blu.png');
  const tone = path.join(directory, 'tone.wav');
  ff('-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', red);
  ff('-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', blu);
  ff('-f', 'lavfi', '-i', 'sine=frequency=750:sample_rate=48000:duration=5', tone);
  const assets = await Promise.all([
    ['red', 'image', red], ['blue', 'image', blu], ['audio', 'audio', tone],
  ].map(async ([id, kind, file]) => ({ id, kind, path: file, sha256: await assetFiles.assetFingerprint(file) })));
  const clip = { in_point: 0, volume: 1 };
  const project = {
    dir: directory, assets,
    tracks: [
      { kind: 'video', clips: Array.from({ length: 40 }, (_, index) => ({
        ...clip, asset_id: 'red', start: index / 8, duration: 1 / 8,
      })) },
      { kind: 'audio', clips: [{ ...clip, asset_id: 'audio', start: 0, duration: 5 }] },
      { kind: 'subtitle', clips: [{ ...clip, start: 4.6, duration: 0.4, text: 'Before' }] },
    ],
  };
  let renders = 0;
  const childProcess = require('node:child_process');
  const nativeSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    if (args.includes('-filter_complex_script')) renders++;
    return nativeSpawn(binary, args, options);
  });
  const options = { preview: true, fps: 24 };
  await media.exportVideo(project, options);
  assert.equal(renders, 3);
  const cache = path.join(directory, '.preview', 'spans-v1');
  const first = fs.readdirSync(cache);
  assert.equal(first.length, 3);

  project.tracks[0].clips.at(-1).asset_id = 'blue';
  project.tracks[2].clips[0].text = 'After';
  renders = 0;
  const fromCache = await media.exportVideo(project, options);
  assert.equal(renders, 1);
  assert.equal(fs.readdirSync(cache).length, 4);
  const cold = await media.exportVideo({ ...project, dir: path.join(directory, 'uncached') }, options);
  const mediaHash = file => ff('-i', file, '-map', '0:v:0', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'framemd5', '-');
  assert.deepEqual(mediaHash(fromCache), mediaHash(cold));

  // Keep the length to prove that reuse checks the bytes as well as the file's presence.
  for (const file of first) {
    const filename = path.join(cache, file);
    const fd = fs.openSync(filename, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, 0); }
    finally { fs.closeSync(fd); }
  }
  renders = 0;
  const repaired = await media.exportVideo(project, options);
  assert.equal(renders, 2);
  assert.deepEqual(mediaHash(repaired), mediaHash(cold));
  const damagedAsset = assets[0];
  fs.copyFileSync(blu, damagedAsset.path);
  await assert.rejects(media.exportVideo(project, options), /素材内容已变更/);
});

test('overlapping tracks with long media paths fit the Windows render command limit', { skip: !hasFFmpeg }, async t => {
  const directory = makeFolder(t);
  const fileName = '配乐 source.wav';
  const baseLength = path.join(directory, '素材 ', fileName).length;
  const sourceDirectory = path.join(directory, '素材 ' + '长'.repeat(Math.max(0, 230 - baseLength)));
  fs.mkdirSync(sourceDirectory);
  const tone = path.join(sourceDirectory, fileName);
  const image = path.join(directory, 'blue.png');
  ff('-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.6', tone);
  ff('-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', image);

  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  let renderCommands = 0;
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    if (args.includes('-filter_complex_script')) {
      renderCommands++;
      const length = [binary, ...args].map(arg => JSON.stringify(arg)).join(' ').length + 1;
      assert.ok(length <= 32767, `FFmpeg render command needs ${length} Windows command-line characters`);
    }
    return spawn(binary, args, options);
  });

  const overlap = 152;
  const project = {
    dir: directory,
    assets: [{ id: 'image', kind: 'image', path: image }, { id: 'tone', kind: 'audio', path: tone }],
    tracks: [
      { kind: 'video', clips: [{ asset_id: 'image', start: 0, in_point: 0, duration: 0.5, volume: 1 }] },
      ...Array.from({ length: overlap }, () => ({
        kind: 'audio', clips: [{ asset_id: 'tone', start: 0.1, in_point: 0.1, duration: 0.3, volume: 1 / overlap }],
      })),
    ],
  };
  const output = await media.exportVideo(project, { preview: true });
  const details = await media.probe(output);
  assert.deepEqual([details.duration, details.video, details.audio], [0.5, true, true]);
  assert.ok(renderCommands > 0);
  assert.ok(fs.existsSync(tone));
  const pcm = ff('-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-');
  assert.ok(pcm.subarray(0, 2400).every(byte => byte === 0));
  assert.ok(pcm.subarray(14400, 19200).some(byte => byte !== 0));
});
