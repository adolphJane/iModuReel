const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const store = require('./store.cjs');
const { hasRenderFile } = require('./media.cjs');
const { copyAssetFile } = require('./asset-file.cjs');
const { resolveTemplate, supportsShotReferences, workflowSeed } = require('./templates.cjs');
const { validateWorkflow } = require('./services.cjs');

const manifestName = 'project.imodureel.json';
const format = 'imodureel-project';
const maxManifestBytes = 128 * 1024 ** 2;
const pending = new Set(['queued', 'preparing', 'running', 'reconnecting', 'collecting', 'rendering', 'disconnected']);
const mediaKinds = new Set(['video', 'audio', 'image']);
const trackKinds = new Set(['video', 'audio', 'subtitle']);
const jobKinds = new Set(['comfy', 'export']);
const finalStates = new Set(['done', 'failed', 'interrupted', 'cancelled']);
const allowedInputs = ['productImage', 'referenceImage', 'referenceVideo', 'sourceVideo'];
const jobFields = ['format', 'resolution', 'fps', 'workflow', 'mapping', 'values', 'shotId', 'assetInputs',
  'assetRevisions', 'outputKinds', 'templateVersion', 'label', 'assets', 'removedAssetCount', 'remoteStatusUnknown', 'seedBinding'];

function invalid(reason) {
  throw new Error('无法恢复项目备份：' + reason);
}

function namedFolder(name, purpose) {
  const safe = name.replace(/[^\p{L}\p{N}_ .-]/gu, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 48);
  return `iModuReel-${purpose}-${safe || 'Project'}-${randomUUID().slice(0, 8)}`;
}

function mediaName(file, index, kind) {
  const extension = path.extname(file).toLowerCase();
  const safe = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : { image: '.png', video: '.mp4', audio: '.m4a' }[kind];
  return `asset-${index}${safe}`;
}

function portableJob(job, files, snapshotAsset, workflowIndex) {
  const detail = JSON.parse(job.detail);
  const portable = selectJobFields(detail);
  const entry = { id: job.id, kind: job.kind, status: job.status, created_at: job.created_at, detail: portable };
  if (detail.workflowRef) portable.workflowIndex = workflowIndex(detail.workflowRef);
  if (job.kind === 'comfy' && job.prompt_id && (pending.has(job.status) || detail.useCurrentEngine)) {
    portable.remoteStatusUnknown = true;
  }
  if (detail.snapshot) {
    portable.snapshot = {
      assets: detail.snapshot.assets.map(snapshotAsset),
      tracks: detail.snapshot.tracks,
    };
  }
  if (job.kind === 'export' && detail.file && job.status === 'done') {
    const name = `render-${files.length}.mp4`;
    portable.file = name;
    files.push({ source: detail.file, folder: 'renders', name, render: entry });
  }
  if (pending.has(job.status) || job.kind === 'export' && job.status === 'done' && !portable.file) entry.status = 'interrupted';
  return entry;
}

function selectJobFields(detail) {
  return Object.fromEntries(jobFields.filter(field => Object.hasOwn(detail, field)).map(field => [field, detail[field]]));
}

function hasSplitTiming(clip) {
  return clip?.split_offset != null || clip?.split_duration != null;
}

function containsSplitTiming(tracks) {
  return tracks.some(track => track.clips.some(hasSplitTiming));
}

function containsLinkedAudio(tracks) {
  return tracks.some(track => track.kind === 'audio' && track.clips.some(clip => clip.linked_video_id));
}

function serializeManifest(manifest) {
  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json) > maxManifestBytes) throw new Error('项目备份的编辑记录超过 128 MiB');
  return json;
}

async function createBackup(projectId, parent, { onProgress } = {}) {
  const project = store.project(projectId, { includeDialogueWindows: true });
  const timelineHistory = store.exportTimelineHistory(projectId, project.tracks);
  const workflow = store.loadWorkflow(projectId);
  const directory = await fs.realpath(parent);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('请选择备份保存目录');
  const files = [];
  const assets = project.assets.map((asset, index) => {
    const name = mediaName(asset.path, index, asset.kind);
    const { id, kind, origin, created_at, duration, job_id, output_key, revision, sha256, generated_sha256 } = asset;
    const record = { id, kind, origin, created_at, name: asset.name, duration, job_id, output_key, revision, sha256,
      ...(generated_sha256 && { generated_sha256 }), file: name, missing: !asset.exists };
    if (asset.exists) files.push({ source: asset.path, folder: 'media', name, asset: record });
    return record;
  });
  const currentAssets = new Map(project.assets.map(asset => [asset.id, asset]));
  const history = new Map();
  const snapshotAsset = ({ id, kind, name, duration, revision, sha256, path: source }) => {
    const asset = { id, kind, name, duration, revision, ...(sha256 && { sha256 }) };
    const current = currentAssets.get(id);
    if ((revision ?? 0) === (current?.revision ?? 0) &&
        (source === current?.path || sha256 && sha256 === current?.sha256)) return asset;
    if (source === current?.path && sha256 && current?.sha256 && sha256 !== current.sha256) return { ...asset, file: null };
    if (!hasRenderFile(source)) return { ...asset, file: null };
    if (!history.has(source)) {
      const file = mediaName(source, history.size, kind);
      files.push({ source, folder: 'history', name: file, sha256 });
      history.set(source, file);
    }
    return { ...asset, file: history.get(source) };
  };
  const jobWorkflows = [];
  const workflowIndexes = new Map();
  const workflowIndex = reference => {
    if (!workflowIndexes.has(reference)) {
      workflowIndexes.set(reference, jobWorkflows.length);
      jobWorkflows.push(store.jobWorkflow(reference));
    }
    return workflowIndexes.get(reference);
  };
  const jobs = project.jobs.filter(job => jobKinds.has(job.kind)).reverse()
    .map(job => portableJob(job, files, snapshotAsset, workflowIndex));
  const historical = jobs.flatMap(job => job.detail.snapshot?.assets.filter(asset => asset.file !== undefined) ?? []);
  const editorDrafts = Object.keys(project.editorDrafts).length ? project.editorDrafts : undefined;
  const versionedResults = Object.keys(project.production.shotSelections ?? {}).length || workflow?.mapping?.seed ||
    jobs.some(job => job.detail.seedBinding || job.detail.values?.seed !== undefined);
  const splitTiming = hasSplitTiming(editorDrafts?.clip) || containsSplitTiming(project.tracks) ||
    jobs.some(job => job.detail.snapshot && containsSplitTiming(job.detail.snapshot.tracks));
  const shotLists = [project.shots, project.production.draftShots, editorDrafts?.shots];
  const shotReferences = shotLists.some(shots => shots?.some(shot => shot?.reference_image_id != null));
  const dialogueAudio = shotLists.some(shots => shots?.some(shot => shot?.dialogue_audio_id != null)) ||
    containsLinkedAudio(project.tracks) || jobs.some(job => job.detail.snapshot && containsLinkedAudio(job.detail.snapshot.tracks));
  const dialogueWindows = [project.tracks, ...(timelineHistory?.entries ?? []).map(entry => entry.tracks)]
    .some(tracks => tracks.some(track => track.clips.some(clip => clip.dialogue_window)));
  const manifest = {
    format, version: dialogueWindows ? 10 : timelineHistory ? 9 : dialogueAudio ? 8 : shotReferences ? 7 : splitTiming ? 6 : versionedResults ? 5 :
      jobWorkflows.length ? 4 : historical.length ? 3 : editorDrafts ? 2 : 1,
    createdAt: new Date().toISOString(),
    project: { name: project.name, template: JSON.parse(project.template_snapshot) },
    production: project.production, workflow,
    assets, shots: project.shots, tracks: project.tracks, jobs, editorDrafts, timelineHistory,
    ...(jobWorkflows.length && { jobWorkflows }),
  };
  serializeManifest(manifest);
  const destination = path.join(directory, namedFolder(project.name, 'Backup'));
  const stage = await fs.mkdtemp(path.join(directory, '.imodureel-backup-'));
  try {
    await copyFiles(files, stage, onProgress);
    const missingRenders = files.filter(file => file.render && file.missing).length;
    const missingHistory = new Set(files.filter(file => file.folder === 'history' && file.missing).map(file => file.name));
    for (const asset of historical) if (missingHistory.has(asset.file)) asset.file = null;
    await fs.writeFile(path.join(stage, manifestName), serializeManifest(manifest), { mode: 0o600, flag: 'wx' });
    await fs.rename(stage, destination);
    return { directory: destination, missingAssets: assets.filter(asset => asset.missing).length, missingRenders };
  } finally {
    await fs.rm(stage, { force: true, recursive: true });
  }
}

async function copyFiles(files, destination, onProgress) {
  let copied = 0;
  for (const file of files) {
    const pocket = path.join(destination, file.folder);
    await fs.mkdir(pocket, { recursive: true });
    const target = path.join(pocket, file.name);
    const optional = file.render || file.folder === 'history';
    try {
      if (optional && !hasRenderFile(file.source)) file.missing = true;
      else if (file.render && (file.folder === 'renders' || file.render.detail.fileSha256)) {
        const detail = file.render.detail;
        const digest = await copyAssetFile(file.source, target);
        if (detail.fileSha256 && detail.fileSha256 !== digest) file.missing = true;
        else detail.fileSha256 = digest;
      } else if (file.asset) {
        const sha256 = await copyAssetFile(file.source, target);
        if (file.asset.sha256 && file.asset.sha256 !== sha256) {
          throw new Error(`素材内容校验失败：${file.asset.name}。请检查文件完整性或重新定位素材。`);
        }
        file.asset.sha256 = sha256;
      } else if (file.sha256) {
        const hash = await copyAssetFile(file.source, target);
        if (hash !== file.sha256) throw new Error(`历史导出使用的文件内容校验失败：${path.basename(file.source)}`);
      } else await fs.copyFile(file.source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') throw error;
      file.missing = true;
    }
    if (file.missing && file.render) {
      await fs.rm(target, { force: true });
      delete file.render.detail.file;
      delete file.render.detail.fileSha256;
      file.render.status = 'interrupted';
    }
    onProgress?.({ completed: ++copied, total: files.length });
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function indexed(items, label) {
  if (!Array.isArray(items)) invalid(label + '格式错误');
  const index = new Map();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || index.has(item.id)) invalid(label + '标识无效或重复');
    index.set(item.id, item);
  }
  return index;
}

function pathPart(value, prefix) {
  if (typeof value !== 'string' || value.length > 32 || !value.startsWith(prefix + '-') ||
      !/^(asset|render)-\d+\.[a-z0-9]{1,8}$/.test(value)) invalid('媒体文件名无效');
  return value;
}

function validAnalysis(analysis) {
  const progress = analysis?.referenceSources?.transcriptionProgress;
  if (progress !== undefined && (!isObject(progress) || !Number.isSafeInteger(progress.total) ||
      !Array.isArray(progress.missing) || !progress.missing.length || progress.missing.length >= progress.total ||
      progress.missing.some((index, position) => !Number.isSafeInteger(index) || index < 1 || index > progress.total ||
        position > 0 && index <= progress.missing[position - 1]))) return false;
  if (analysis?.referenceSources?.transcription === 'partial' &&
      (!progress || typeof analysis.referenceTranscript !== 'string' || !analysis.referenceTranscript.trim())) return false;
  return isObject(analysis) && typeof analysis.summary === 'string' &&
    (analysis.referenceTranscript === undefined || typeof analysis.referenceTranscript === 'string') &&
    Array.isArray(analysis.characters) && analysis.characters.every(item => typeof item === 'string') &&
    Array.isArray(analysis.scenes) &&
    analysis.scenes.every(scene => typeof scene?.title === 'string' && typeof scene.description === 'string');
}

function validWorkflowDraft(draft) {
  return isObject(draft) && typeof draft.workflow === 'string' && typeof draft.mapping === 'string';
}

function validateEditorDrafts(drafts, assets, tracks) {
  if (!isObject(drafts) || Object.keys(drafts).some(section => !['inputs', 'analysis', 'shots', 'workflow', 'clip'].includes(section))) {
    invalid('编辑草稿格式错误');
  }
  const { inputs, analysis, shots, workflow, clip } = drafts;
  if (inputs !== undefined && (!isObject(inputs) || Object.values(inputs).some(value => typeof value !== 'string') ||
      allowedInputs.some(key => inputs[key] && !assets.has(inputs[key])))) invalid('输入编辑草稿无效');
  if (analysis !== undefined && (!validAnalysis(analysis) || analysis.sceneCuts != null &&
      (!Array.isArray(analysis.sceneCuts) || analysis.sceneCuts.some(cut => !Number.isFinite(cut?.start) ||
        cut.end != null && !Number.isFinite(cut.end))))) invalid('分析编辑草稿无效');
  if (workflow !== undefined && !validWorkflowDraft(workflow)) invalid('工作流编辑草稿无效');
  if (shots !== undefined) {
    indexed(shots, '分镜编辑草稿');
    if (shots.some(shot => !Number.isFinite(shot.duration) ||
        [shot.title, shot.prompt, shot.dialogue].some(value => typeof value !== 'string') ||
        shot.characters != null && (!Array.isArray(shot.characters) || shot.characters.some(item => typeof item !== 'string')))) {
      invalid('分镜编辑草稿无效');
    }
  }
  if (clip !== undefined) {
    const saved = tracks.find(track => track.id === clip?.track_id)?.clips.find(item => item.id === clip.id);
    if (!saved || saved.asset_id !== clip.asset_id || (saved.linked_video_id ?? null) !== (clip.linked_video_id ?? null) ||
        typeof clip.text !== 'string' || !['none', 'fade'].includes(clip.transition) ||
        ![clip.start, clip.in_point, clip.duration, clip.volume].every(Number.isFinite)) invalid('片段编辑草稿无效');
  }
}

function validateBackup(manifest) {
  if (!isObject(manifest) || manifest.format !== format || !Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > 10) {
    invalid('备份格式或版本不受支持');
  }
  const { project, production, workflow, assets, tracks, shots, jobs } = manifest;
  if (!isObject(project) || typeof project.name !== 'string' || !project.name.trim() || !isObject(project.template) ||
      !Number.isInteger(project.template.version) || !isObject(production)) invalid('项目或模板信息缺失');
  const template = resolveTemplate({ template_id: project.template.id, template_snapshot: JSON.stringify(project.template) });
  if (!isObject(workflow) && workflow !== null) invalid('工作流格式错误');
  if (workflow) validateWorkflow(workflow.workflow, workflow.mapping);
  const assetIndex = indexed(assets, '素材');
  const savedShots = indexed(shots, '已保存分镜');
  const jobIndex = indexed(jobs, '任务');
  for (const asset of assets) {
    pathPart(asset.file, 'asset');
    if (!mediaKinds.has(asset.kind) || typeof asset.name !== 'string' || typeof asset.origin !== 'string' ||
        typeof asset.missing !== 'boolean' ||
        asset.sha256 != null && (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) ||
        asset.generated_sha256 != null && (asset.origin !== 'comfy' || !asset.job_id ||
          typeof asset.generated_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.generated_sha256)) ||
        asset.job_id != null && !jobIndex.has(asset.job_id)) invalid('素材信息无效');
  }
  if (new Set(assets.map(asset => asset.file)).size !== assets.length) invalid('素材文件重复');
  if (production.inputs !== undefined && !isObject(production.inputs)) invalid('项目输入格式错误');
  if (production.analysis != null && !validAnalysis(production.analysis)) invalid('项目分析格式错误');
  const checkpoint = production.transcriptionCheckpoint;
  if (checkpoint !== undefined && (template.id !== 'drama' || !isObject(checkpoint) || typeof checkpoint.key !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checkpoint.key) || !Array.isArray(checkpoint.segments) ||
      checkpoint.segments.some(part => part !== null && typeof part !== 'string') ||
      !checkpoint.segments.some(part => typeof part === 'string'))) invalid('参考视频转写记录无效');
  if (production.workflowDraft != null && !validWorkflowDraft(production.workflowDraft)) invalid('工作流草稿格式错误');
  if (allowedInputs.some(key => production.inputs?.[key] && !assetIndex.has(production.inputs[key])) ||
      production.approvedOutput && !assetIndex.has(production.approvedOutput)) invalid('项目输入指向缺失的素材记录');
  if (production.enhancementReviews !== undefined && (project.template.id !== 'enhance' ||
      !isObject(production.enhancementReviews) ||
      Object.entries(production.enhancementReviews).some(([id, revision]) => {
        const asset = assetIndex.get(id);
        return asset?.kind !== 'video' || asset.origin !== 'comfy' ||
          !Number.isSafeInteger(revision) || revision < 0 || revision > (asset.revision ?? 0);
      }))) invalid('增强结果的审核记录无效');
  for (const shot of savedShots.values()) {
    if (!['approved', 'draft'].includes(shot.status)) invalid('分镜审核状态无效');
  }
  store.normalizeShots(shots);
  for (const list of [production.draftShots, production.analysisShots]) {
    if (list != null) store.normalizeShots(list);
  }
  validateTimeline(tracks, assetIndex, manifest.version);
  if (manifest.version === 9 || manifest.version === 10 && manifest.timelineHistory !== undefined) {
    validateTimelineHistory(manifest.timelineHistory, tracks, assetIndex, manifest.version);
  }
  else if (manifest.timelineHistory !== undefined) invalid('备份版本不支持时间线撤销与重做记录');
  if (manifest.version === 2 || manifest.version >= 3 && manifest.editorDrafts !== undefined) {
    validateEditorDrafts(manifest.editorDrafts, assetIndex, tracks);
  }
  const editingShots = manifest.version >= 2 ? manifest.editorDrafts?.shots : undefined;
  for (const list of [shots, production.draftShots, editingShots]) {
    if (list?.some(shot => shot.reference_image_id != null &&
        (manifest.version < 7 || !supportsShotReferences(template) || assetIndex.get(shot.reference_image_id)?.kind !== 'image'))) {
      invalid('分镜参考图指向无效的项目素材');
    }
    if (list?.some(shot => shot.dialogue_audio_id != null &&
        (manifest.version < 8 || template.id !== 'drama' || assetIndex.get(shot.dialogue_audio_id)?.kind !== 'audio'))) {
      invalid('分镜配音指向无效的项目素材');
    }
  }
  if (production.analysisShots?.some(shot => shot.reference_image_id != null || shot.dialogue_audio_id != null)) {
    invalid('AI 分镜建议包含未审核的参考图或配音');
  }
  if (manifest.version === 4 || manifest.version >= 5 && manifest.jobWorkflows !== undefined) {
    if (!Array.isArray(manifest.jobWorkflows) || !manifest.jobWorkflows.length) invalid('任务工作流索引缺失');
    for (const spec of manifest.jobWorkflows) {
      if (!isObject(spec)) invalid('任务工作流快照无效');
      validateWorkflow(spec.workflow, spec.mapping);
    }
  }
  const renderFiles = new Set();
  for (const job of jobs) {
    if (!jobKinds.has(job.kind) || !isObject(job.detail) || !finalStates.has(job.status)) invalid('任务记录无效');
    const detail = job.detail;
    if (detail.file !== undefined) {
      pathPart(detail.file, 'render');
      if (job.kind !== 'export' || job.status !== 'done' || !detail.file.endsWith('.mp4') || renderFiles.has(detail.file)) {
        invalid('导出文件记录无效');
      }
      renderFiles.add(detail.file);
    }
    if (detail.fileSha256 !== undefined &&
        (!detail.file || typeof detail.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(detail.fileSha256))) {
      invalid('成片文件指纹无效');
    }
    if (detail.assetInputs && (!isObject(detail.assetInputs) ||
        Object.values(detail.assetInputs).some(assetId => !assetIndex.has(assetId)))) invalid('生成任务指向缺失的素材记录');
    if (detail.assets && (!Array.isArray(detail.assets) || detail.assets.some(assetId => !assetIndex.has(assetId)))) {
      invalid('生成结果指向缺失的素材记录');
    }
    if (detail.removedAssetCount !== undefined && (!Number.isSafeInteger(detail.removedAssetCount) || detail.removedAssetCount < 0)) {
      invalid('素材清理记录无效');
    }
    if (detail.workflow) validateWorkflow(detail.workflow, detail.mapping);
    if (detail.workflowIndex !== undefined && (manifest.version < 4 || job.kind !== 'comfy' ||
        detail.workflow !== undefined || detail.mapping !== undefined || !Number.isInteger(detail.workflowIndex) ||
        !manifest.jobWorkflows?.[detail.workflowIndex])) invalid('任务工作流引用无效');
    if (detail.values?.seed !== undefined && (!Number.isSafeInteger(detail.values.seed) || detail.values.seed < 0)) {
      invalid('生成任务种子无效');
    }
    if (detail.seedBinding !== undefined) {
      const specification = detail.workflow ? detail : manifest.jobWorkflows?.[detail.workflowIndex];
      if (manifest.version < 5 || job.kind !== 'comfy' || !specification || specification.mapping?.seed ||
          !isObject(detail.seedBinding) || detail.values?.seed === undefined) invalid('生成任务种子映射无效');
      validateWorkflow(specification.workflow, { ...specification.mapping, seed: detail.seedBinding });
      workflowSeed(specification.workflow, detail.seedBinding);
    }
    if (detail.remoteStatusUnknown !== undefined && typeof detail.remoteStatusUnknown !== 'boolean') invalid('任务远端状态无效');
    if (detail.snapshot) {
      if (!isObject(detail.snapshot) || !Array.isArray(detail.snapshot.assets) ||
          detail.snapshot.assets.some(asset => !assetIndex.has(asset?.id))) invalid('导出快照格式错误');
      for (const asset of detail.snapshot.assets) {
        if (manifest.version >= 3 && asset.file != null) pathPart(asset.file, 'asset');
        if (asset.sha256 != null && (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))) {
          invalid('导出快照的素材指纹无效');
        }
      }
      validateTimeline(detail.snapshot.tracks, assetIndex, Math.min(manifest.version, 9));
    }
  }
  if (production.shotSelections !== undefined && (manifest.version < 5 || project.template.id === 'enhance' ||
      !isObject(production.shotSelections) || Object.entries(production.shotSelections).some(([shotId, assetId]) => {
        const asset = assetIndex.get(assetId);
        const job = jobIndex.get(asset?.job_id);
        return savedShots.get(shotId)?.status !== 'approved' || !asset || asset.origin !== 'comfy' ||
          !['video', 'image'].includes(asset.kind) || job?.kind !== 'comfy' || job.status !== 'done' ||
          job.detail.shotId !== shotId || !job.detail.assets?.includes(assetId);
      }))) invalid('分镜的已选版本记录无效');
}

function validateTimeline(tracks, assets, version) {
  indexed(tracks, '轨道');
  for (const track of tracks) {
    if (!trackKinds.has(track.kind) || typeof track.name !== 'string' || !Array.isArray(track.clips)) invalid('轨道内容无效');
  }
  indexed(tracks.flatMap(track => track.clips), '片段');
  const videos = new Map(tracks.filter(track => track.kind === 'video').flatMap(track => track.clips.map(clip => [clip.id, clip])));
  for (const track of tracks) {
    for (const clip of track.clips) {
      const parent = videos.get(clip.linked_video_id);
      const linkedAudio = version >= 8 && track.kind === 'audio' && assets.get(clip.asset_id)?.kind === 'audio';
      if (clip.track_id !== track.id || track.kind !== 'subtitle' && !assets.has(clip.asset_id) ||
          clip.linked_video_id && (!parent || (track.kind !== 'subtitle' && !linkedAudio)) || typeof clip.text !== 'string' ||
          !['none', 'fade'].includes(clip.transition) || ![clip.start, clip.duration, clip.in_point, clip.volume].every(Number.isFinite)) {
        invalid('时间线片段引用无效');
      }
      if (parent && linkedAudio && (clip.start < parent.start - 0.000001 ||
          clip.start + clip.duration > parent.start + parent.duration + 0.000001)) invalid('关联配音超出镜头范围');
      if (clip.dialogue_window !== undefined || clip.duration === 0) {
        const window = clip.dialogue_window;
        if (version < 10 || !parent || !linkedAudio || !isObject(window) ||
            ![window.offset, window.inPoint, window.duration].every(Number.isFinite) ||
            window.offset < 0 || window.inPoint < 0 || window.duration <= 0 || window.duration > 86400) {
          invalid('关联配音的原始时序无效');
        }
        const start = Math.max(window.offset, parent.in_point);
        const end = Math.min(window.offset + window.duration, parent.in_point + parent.duration);
        const visible = Math.round((end - start) * 1e9) / 1e9;
        const audible = visible >= 0.04;
        if (Math.abs(clip.duration - (audible ? visible : 0)) > 1e-6 ||
            Math.abs(clip.start - (parent.start + (audible ? start - parent.in_point : 0))) > 1e-6 ||
            Math.abs(clip.in_point - (window.inPoint + (audible ? start - window.offset : 0))) > 1e-6) {
          invalid('关联配音的裁切范围无效');
        }
      }
      if (hasSplitTiming(clip) && (version < 6 || track.kind !== 'video' ||
          ![clip.split_offset, clip.split_duration].every(Number.isFinite) || clip.split_offset < 0 ||
          clip.split_duration < 0.04 || clip.split_duration > 86400 || clip.split_offset + clip.duration > clip.split_duration + 0.000001)) {
        invalid('拆分片段的时序记录无效');
      }
    }
  }
}

function validateTimelineHistory(history, tracks, assets, version) {
  const { cursor, entries } = history ?? {};
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > store.timelineHistoryLimit ||
      !Number.isInteger(cursor) || cursor < 0 || cursor >= entries.length ||
      !isDeepStrictEqual(entries[cursor]?.tracks, tracks)) invalid('时间线撤销与重做记录无效');
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry) || !(index === 0 && entry.action === null || typeof entry.action === 'string' && entry.action.trim())) {
      invalid('时间线编辑记录无效');
    }
    validateTimeline(entry.tracks, assets, version);
    if (entry.tracks.some((track, position) => !Number.isSafeInteger(track.position) || track.position < 0 ||
        position > 0 && track.position <= entry.tracks[position - 1].position)) invalid('时间线历史轨道顺序无效');
  }
}

async function sourceFile(directory, folder, name, { optional = false } = {}) {
  try {
    const file = await fs.realpath(path.join(directory, folder, name));
    const relative = path.relative(directory, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        !(await fs.stat(file)).isFile()) invalid('媒体文件不在备份目录内');
    return file;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (optional) return null;
    invalid(`缺少 ${folder}/${name}`);
  }
}

function remapBackup(manifest, destination) {
  const remapper = () => {
    const mapped = new Map();
    return (previous) => {
      if (!previous) return null;
      if (!mapped.has(previous)) mapped.set(previous, store.id());
      return mapped.get(previous);
    };
  };
  const assetId = remapper();
  const jobId = remapper();
  const shotId = remapper();
  const trackId = remapper();
  const clipId = remapper();
  const rewriteClip = clip => ({
    ...clip, id: clipId(clip.id), track_id: trackId(clip.track_id), asset_id: assetId(clip.asset_id),
    linked_video_id: clipId(clip.linked_video_id),
  });
  const rewriteTracks = tracks => tracks.map(track => ({
    ...track, id: trackId(track.id), clips: track.clips.map(rewriteClip),
  }));
  const rewriteShots = shots => shots.map(({ project_id, reference_image_id, dialogue_audio_id, ...shot }) => ({
    ...shot, id: shotId(shot.id) || store.id(),
    ...(reference_image_id && { reference_image_id: assetId(reference_image_id) }),
    ...(dialogue_audio_id && { dialogue_audio_id: assetId(dialogue_audio_id) }),
  }));
  const rewriteInputs = inputs => {
    const rewritten = { ...inputs };
    for (const key of allowedInputs) if (rewritten[key]) rewritten[key] = assetId(rewritten[key]);
    return rewritten;
  };

  const assets = manifest.assets.map(({ file, missing, ...asset }) => ({
    ...asset, id: assetId(asset.id), path: path.join(destination, 'assets', file), job_id: jobId(asset.job_id),
  }));
  const current = new Map(manifest.assets.map((asset, index) => [asset.id, assets[index]]));
  const production = { ...manifest.production };
  if (production.inputs) production.inputs = rewriteInputs(production.inputs);
  if (production.approvedOutput) production.approvedOutput = assetId(production.approvedOutput);
  if (production.enhancementReviews) production.enhancementReviews = Object.fromEntries(
    Object.entries(production.enhancementReviews).map(([id, revision]) => [assetId(id), revision]));
  if (production.shotSelections) production.shotSelections = Object.fromEntries(
    Object.entries(production.shotSelections).map(([shot, asset]) => [shotId(shot), assetId(asset)]));
  for (const key of ['draftShots', 'analysisShots']) {
    if (production[key]) production[key] = rewriteShots(production[key]);
  }
  const editorDrafts = manifest.version >= 2 ? { ...manifest.editorDrafts } : {};
  if (editorDrafts.inputs) editorDrafts.inputs = rewriteInputs(editorDrafts.inputs);
  if (editorDrafts.shots) editorDrafts.shots = rewriteShots(editorDrafts.shots);
  if (editorDrafts.clip) editorDrafts.clip = rewriteClip(editorDrafts.clip);
  const jobs = manifest.jobs.map(job => {
    const detail = selectJobFields(job.detail);
    if (job.detail.workflowIndex !== undefined) {
      const { workflow, mapping } = manifest.jobWorkflows[job.detail.workflowIndex];
      Object.assign(detail, { workflow, mapping });
    }
    if (job.detail.file) detail.file = path.join(destination, 'exports', job.detail.file);
    if (detail.shotId) detail.shotId = shotId(detail.shotId);
    if (detail.assets) detail.assets = detail.assets.map(assetId);
    if (detail.assetInputs) {
      detail.assetInputs = Object.fromEntries(Object.entries(detail.assetInputs).map(([role, previous]) => [role, assetId(previous)]));
    }
    if (job.detail.snapshot) {
      detail.snapshot = {
        dir: destination,
        assets: job.detail.snapshot.assets.map(({ id, kind, name, duration, revision, file, sha256 }) => {
          const latest = current.get(id);
          let source = (latest.revision ?? 0) === (revision ?? 0) ? latest.path : null;
          if (manifest.version >= 3 && file !== undefined) {
            source = file === null ? null : path.join(destination, 'assets', 'history', file);
          }
          return { id: assetId(id), kind, name, duration, revision, path: source, ...(sha256 && { sha256 }) };
        }),
        tracks: rewriteTracks(job.detail.snapshot.tracks),
      };
    }
    if (job.kind === 'comfy') detail.useCurrentEngine = true;
    if (job.status === 'failed' || job.status === 'interrupted') {
      if (job.kind === 'export') {
        detail.error = detail.snapshot ? '成片文件不可用，可以按原设置重新导出。' : '成片文件不可用，请从时间线重新导出。';
      } else detail.error = detail.remoteStatusUnknown ? '远端任务状态未知。可使用当前引擎重试。' : '原项目中该任务尚未完成，可以重试。';
    }
    return { ...job, id: jobId(job.id), detail };
  });
  return {
    dir: destination, name: manifest.project.name, template: manifest.project.template,
    assets, production, workflow: manifest.workflow, editorDrafts, jobs,
    shots: rewriteShots(manifest.shots), tracks: rewriteTracks(manifest.tracks),
    ...(manifest.timelineHistory && { timelineHistory: {
      cursor: manifest.timelineHistory.cursor,
      entries: manifest.timelineHistory.entries.map(({ action, tracks }) => ({ action, tracks: rewriteTracks(tracks) })),
    } }),
  };
}

async function restoreBackup(file, parent, { onProgress } = {}) {
  const realFile = await fs.realpath(file);
  const directory = path.dirname(realFile);
  const info = await fs.stat(realFile);
  if (!info.isFile() || info.size > maxManifestBytes) invalid('备份记录不可读取或超过 128 MiB');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(realFile, 'utf8')); }
  catch { invalid('备份记录不是有效的 JSON'); }
  validateBackup(manifest);
  const target = await fs.realpath(parent);
  if (!(await fs.stat(target)).isDirectory()) invalid('请选择恢复位置');
  const files = [];
  for (const asset of manifest.assets) {
    if (!asset.missing) files.push({ source: await sourceFile(directory, 'media', asset.file), folder: 'assets', name: asset.file, asset });
  }
  const history = new Set();
  for (const job of manifest.jobs) {
    if (job.detail.file) {
      const source = await sourceFile(directory, 'renders', job.detail.file, { optional: true });
      files.push({ source, folder: 'exports', name: job.detail.file, render: job });
    }
    if (manifest.version >= 3) {
      for (const asset of job.detail.snapshot?.assets ?? []) {
        if (!asset.file || history.has(asset.file)) continue;
        files.push({ source: await sourceFile(directory, 'history', asset.file), folder: path.join('assets', 'history'),
          name: asset.file, sha256: asset.sha256 });
        history.add(asset.file);
      }
    }
  }
  const destination = path.join(target, namedFolder(manifest.project.name, 'Project'));
  const stage = await fs.mkdtemp(path.join(target, '.imodureel-restore-'));
  let promoted = false;
  try {
    await fs.mkdir(path.join(stage, 'assets'));
    await fs.mkdir(path.join(stage, 'exports'));
    await fs.mkdir(path.join(stage, 'workflows'));
    await copyFiles(files, stage, onProgress);
    await fs.rename(stage, destination);
    promoted = true;
    const project = store.restoreProject(remapBackup(manifest, destination));
    return {
      project, missingAssets: manifest.assets.filter(asset => asset.missing).length,
      missingRenders: files.filter(file => file.render && file.missing).length,
    };
  } catch (error) {
    if (promoted) await fs.rm(destination, { force: true, recursive: true });
    throw error;
  } finally {
    await fs.rm(stage, { force: true, recursive: true });
  }
}

module.exports = { createBackup, restoreBackup, manifestName };
