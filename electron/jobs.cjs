const path = require('node:path');
const fs = require('node:fs/promises');
const { isDeepStrictEqual } = require('node:util');
const store = require('./store.cjs');
const services = require('./services.cjs');
const media = require('./media.cjs');
const engine = require('./engine.cjs');
const { uploadTag, scopeOutputs, removeUploads, removeOutputs } = require('./comfy-media.cjs');
const { assetFingerprint, assetFileState, requireAssetFile, isStorageFull, storageFullMessage } = require('./asset-file.cjs');
const { isBuiltInEnhancement, mpsVideoWorkflow } = require('./presets.cjs');
const { defaultRenderSettings, renderClips } = require('./render-clips.mjs');

const activeStates = new Set(['queued', 'preparing', 'running', 'reconnecting', 'collecting', 'rendering']);
const resumable = new Set(['reconnecting', 'disconnected']);
const retryable = new Set(['failed', 'cancelled', 'interrupted']);
const batchOutputKey = 'enhanced-video';
const obsoletePreview = { file: null, error: '时间线或预览设置已更新，可以重新生成当前预览。', progress: null };

function renderAssetIds(tracks) {
  return new Set(tracks.flatMap(track => track.clips.map(clip => clip.asset_id)).filter(Boolean));
}

function createRenderSnapshot(project) {
  if (!project.tracks.some(track => track.clips.length)) throw new Error('请先添加时间线片段');
  const used = renderAssetIds(project.tracks);
  const assets = project.assets.filter(asset => used.has(asset.id));
  assets.forEach(store.requireEnhancementReview);
  return { dir: project.dir, assets, tracks: project.tracks };
}

function previewMatchesTimeline(projectId, { snapshot, format = 'landscape', fps = 30 }) {
  if (snapshot.dir !== store.projectRow(projectId).dir) return false;
  const settings = store.production(projectId).exportSettings;
  if (settings && (format !== settings.format || fps !== (settings.fps ?? 30))) return false;
  const tracks = store.projectTracks(projectId);
  if (renderClips(tracks) !== renderClips(snapshot.tracks)) return false;
  const used = renderAssetIds(tracks);
  if (!used.size) return true;
  const original = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  const assets = store.assets(projectId).filter(asset => used.has(asset.id));
  return assets.length === used.size && assets.every(asset => {
    const previous = original.get(asset.id);
    return asset.exists && previous && (asset.revision ?? 0) === (previous.revision ?? 0) &&
      (!asset.sha256 || !previous.sha256 || asset.sha256 === previous.sha256);
  });
}

function batchDirectory(job) {
  return path.join(store.projectRow(job.project_id).dir, '.enhancement', job.id);
}

async function saveSegmentChecksum(file, signal, source = file) {
  const digest = await assetFingerprint(source, signal);
  const receipt = file + '.sha256';
  const temporary = receipt + '.tmp';
  try {
    await fs.writeFile(temporary, digest);
    signal.throwIfAborted();
    await fs.rename(temporary, receipt);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function enhancementSegmentReady(file, frames, signal) {
  const receipt = await fs.readFile(file + '.sha256', 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (receipt !== null) {
    return /^[a-f0-9]{64}$/.test(receipt) && await assetFileState({ path: file, sha256: receipt }, signal) === 'ready';
  }
  // Jobs from before checksums were saved can still reuse decodable segments.
  return media.hasRenderFile(file) && await decodedSegmentFrames(file, signal) === frames;
}

async function decodedSegmentFrames(file, signal) {
  try {
    return await media.countVideoFrames(file, signal, { decode: true });
  } catch (error) {
    signal.throwIfAborted();
    if (isStorageFull(error)) throw error;
    return 0;
  }
}

function renderOutput(job, snapshot) {
  return job.kind === 'preview'
    ? path.join(snapshot.dir, '.preview', job.id + '.mp4')
    : path.join(snapshot.dir, 'exports', 'iModuReel-' + job.id + '.mp4');
}

function completedRender(job, snapshot) {
  const file = renderOutput(job, snapshot);
  // FFmpeg publishes the final name after a successful render.
  if (media.hasRenderFile(file)) return file;
}

function generationTargetKey(payload) {
  return payload.engineDir ? 'local:' + path.resolve(payload.engineDir) : 'external:' + payload.url;
}

function completedPromptOutputs(job) {
  if (!job.prompt_id) return null;
  const { outputReceipt, engineDir } = JSON.parse(job.detail);
  if (outputReceipt?.promptId === job.prompt_id && Array.isArray(outputReceipt.files)) {
    return { completed: { files: outputReceipt.files } };
  }
  return engine.completedPromptOutputs(engineDir, job.prompt_id);
}

function registeredOutputs(job, outputKinds) {
  const assets = store.assets(job.project_id).filter(asset => asset.job_id === job.id);
  return assets.length && (!outputKinds?.length || assets.some(asset => outputKinds.includes(asset.kind))) ? assets : [];
}

function canRetryOnCurrentEngine(job, target) {
  if (job.kind !== 'comfy' || !retryable.has(job.status) || !target) return false;
  const payload = JSON.parse(job.detail);
  return !payload.useCurrentEngine && generationTargetKey(payload) !== generationTargetKey(target);
}

function createJobs(emit, { managedInstance = () => null, connectManaged } = {}) {
  const active = new Map();
  const renderQueue = [];
  const generationLanes = new Map();
  const cancelling = new Set();
  const recovering = new Set();
  const releasingMedia = new Set();
  const storageWaiters = new Map();
  const shutdown = new AbortController();
  let rendering = false;
  let exiting = false;

  function patch(job, status, detailPatch = {}, fields = {}) {
    const update = { status, detail: JSON.stringify({ ...JSON.parse(job.detail), ...detailPatch }), ...fields };
    store.updateJob(job.id, update);
    Object.assign(job, update);
    if (job.kind === 'comfy') {
      const lane = generationLane(JSON.parse(job.detail));
      if (status === 'disconnected') {
        lane.paused.add(job.id);
        lane.uploads.clear();
        notifyQueue(lane, job.project_id);
      } else lane.paused.delete(job.id);
    }
    emit({ id: job.id, projectId: job.project_id, status, ...detailPatch.progress !== undefined && { progress: detailPatch.progress } });
  }

  function recordRender(job, payload, file) {
    if (job.kind === 'preview' && !previewMatchesTimeline(job.project_id, payload)) {
      patch(job, 'interrupted', obsoletePreview);
    } else patch(job, 'done', { file, progress: 1, error: null });
  }

  function cleanPreviewFiles(job, payload, file) {
    if (job.kind !== 'preview') return;
    if (job.status === 'interrupted') {
      void fs.rm(file, { force: true }).catch(() => {});
      return;
    }
    // Recovery can finish older jobs after a newer preview has already been published.
    const completed = store.all(`SELECT id FROM jobs WHERE project_id = ? AND kind = 'preview' AND status = 'done'
      ORDER BY created_at DESC, rowid DESC`, [job.project_id]);
    for (const { id } of completed.slice(1)) {
      void fs.rm(path.join(payload.snapshot.dir, '.preview', id + '.mp4'), { force: true }).catch(() => {});
    }
  }

  function storageIssue(jobId) {
    if (storageWaiters.has(jobId)) return {
      message: storageFullMessage,
      canCancel: !active.get(jobId)?.completed && !cancelling.has(jobId) && !recovering.has(jobId),
    };
  }

  function waitForStorage(job, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const announce = () => emit({ id: job.id, projectId: job.project_id, status: job.status });
      const finish = aborted => {
        storageWaiters.delete(job.id);
        signal.removeEventListener('abort', onAbort);
        if (aborted) reject(signal.reason);
        else resolve();
        announce();
      };
      const onAbort = () => finish(true);
      signal.addEventListener('abort', onAbort, { once: true });
      storageWaiters.set(job.id, () => finish(false));
      announce();
    });
  }

  async function withStorageRetry(job, signal, operation) {
    for (;;) {
      signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        signal.throwIfAborted();
        if (!isStorageFull(error)) throw error;
      }
      await waitForStorage(job, signal);
    }
  }

  function generationLane(payload) {
    const key = generationTargetKey(payload);
    if (!generationLanes.has(key)) generationLanes.set(key, {
      key, pending: [], inFlight: null, paused: new Set(), uploads: new Map(),
    });
    return generationLanes.get(key);
  }

  function removeUnusedLane(lane) {
    if (!lane.inFlight && !lane.pending.length && !lane.paused.size) generationLanes.delete(lane.key);
  }

  function dropUnusedUploads(lane, batchId) {
    if (batchId && lane.inFlight?.batchId !== batchId && !lane.pending.some(entry => entry.batchId === batchId)) {
      lane.uploads.delete(batchId);
    }
  }

  async function cleanManaged(operation) {
    try { await operation(); }
    catch (error) { console.warn('Unable to release managed ComfyUI media:', error.message); }
  }

  function uploadOwnerActive(status) {
    return activeStates.has(status) || status === 'disconnected';
  }

  async function releaseJobMedia(job, { preserveOutput = false } = {}) {
    const { engineDir, batchId } = JSON.parse(job.detail);
    if (!engineDir) return;
    releasingMedia.add(job.id);
    try {
      await cleanManaged(async () => {
        const owners = new Set([job.id]);
        if (batchId) {
          const batch = store.all(`SELECT status, json_extract(detail, '$.remoteStatusUnknown') AS unknown FROM jobs
            WHERE kind = 'comfy' AND id != ? AND json_extract(detail, '$.engineDir') = ?
            AND json_extract(detail, '$.batchId') = ?`, [job.id, engineDir, batchId]);
          if (!batch.some(({ status, unknown }) => uploadOwnerActive(status) || unknown)) owners.add(batchId);
        }
        await Promise.allSettled([
          cleanManaged(() => removeUploads(engineDir, owners)),
          !preserveOutput && cleanManaged(() => removeOutputs(engineDir, new Set([job.id]))),
          !preserveOutput && engine.forgetPromptCompletion(engineDir, job.prompt_id),
        ]);
      });
    } finally {
      releasingMedia.delete(job.id);
    }
  }

  function reclaimFinishedMedia() {
    const groups = new Map();
    const rows = store.all(`SELECT id, status, prompt_id, json_extract(detail, '$.engineDir') AS engineDir,
      json_extract(detail, '$.batchId') AS batchId, json_extract(detail, '$.useCurrentEngine') AS abandoned
      FROM jobs WHERE kind = 'comfy' AND json_type(detail, '$.engineDir') = 'text'`);
    for (const { id, status, prompt_id, engineDir, batchId, abandoned } of rows) {
      if (!groups.has(engineDir)) groups.set(engineDir, { finished: new Set(), uploads: new Set(), retained: new Set(), receipts: [] });
      const group = groups.get(engineDir);
      if (uploadOwnerActive(status)) {
        group.retained.add(batchId || id);
        continue;
      }
      if (status !== 'done' && status !== 'cancelled' && !(status === 'interrupted' && abandoned)) continue;
      group.finished.add(id);
      group.uploads.add(id);
      if (batchId) group.uploads.add(batchId);
      if (prompt_id) group.receipts.push(prompt_id);
    }
    for (const [root, { finished, uploads, retained, receipts }] of groups) {
      for (const owner of retained) uploads.delete(owner);
      void cleanManaged(() => removeUploads(root, uploads));
      void cleanManaged(() => removeOutputs(root, finished));
      for (const promptId of receipts) void engine.forgetPromptCompletion(root, promptId);
    }
  }

  function notifyQueue(lane, sourceProjectId) {
    const notified = new Set([sourceProjectId]);
    for (const { job } of lane.pending) {
      if (notified.has(job.project_id)) continue;
      notified.add(job.project_id);
      emit({ id: job.id, projectId: job.project_id, status: 'queued' });
    }
  }

  function pumpGeneration(lane) {
    if (exiting || lane.inFlight) return;
    const recovery = lane.pending.findIndex(entry => entry.priority);
    if (!lane.pending.length || lane.paused.size && recovery === -1) {
      removeUnusedLane(lane);
      return;
    }
    const [entry] = lane.pending.splice(Math.max(0, recovery), 1);
    lane.inFlight = entry;
    launch(entry.job, { resume: entry.resume, lane });
    notifyQueue(lane, entry.job.project_id);
  }

  function finishGeneration(lane, job) {
    if (lane.inFlight?.job.id !== job.id) return;
    const { batchId } = lane.inFlight;
    lane.inFlight = null;
    dropUnusedUploads(lane, batchId);
    pumpGeneration(lane);
  }

  function queueGeneration(job, { resume = false, priority = false, pump = true } = {}) {
    const payload = JSON.parse(job.detail);
    const lane = generationLane(payload);
    if (!active.has(job.id) && !lane.pending.some(entry => entry.job.id === job.id)) {
      lane.pending.push({ job, resume, priority, batchId: payload.batchId });
    }
    if (pump) pumpGeneration(lane);
    return lane;
  }

  function queueInfo(projectId) {
    const information = new Map();
    for (const lane of generationLanes.values()) {
      lane.pending.forEach(({ job }, index) => {
        if (job.project_id === projectId) information.set(job.id, { position: index + 1, paused: lane.paused.size > 0 });
      });
    }
    return information;
  }

  function launch(job, { resume = false, lane } = {}) {
    if (active.has(job.id)) return job;
    const controller = { abort: new AbortController(), cancelling: false };
    const { signal } = controller.abort;
    const withStorage = operation => withStorageRetry(job, signal, operation);
    const saveState = (...args) => withStorage(() => patch(job, ...args));
    active.set(job.id, controller);
    const payload = JSON.parse(job.detail);
    const managedMps = payload.engineDir && process.platform === 'darwin' && process.arch === 'arm64';
    const uploadedRoles = Object.keys(payload.assetInputs ?? {});
    let workflow;
    let mapping;
    let mpsVideo;
    let checkedUrl = null;
    controller.execution = (async () => {
      try {
        if (job.kind === 'comfy') {
          let assets = resume ? await withStorage(verifyRegisteredOutputs) : null;
          if (!assets) {
            if (payload.workflowRef) Object.assign(payload, store.jobWorkflow(payload.workflowRef));
            workflow = payload.workflow;
            const mpsWorkflow = mpsVideoWorkflow(workflow, payload.mapping, payload.values?.frameCount);
            if (mpsWorkflow !== workflow) {
              mpsVideo = mpsWorkflow;
              if (managedMps) workflow = mpsWorkflow;
            }
            mapping = payload.seedBinding ? { ...payload.mapping, seed: payload.seedBinding } : payload.mapping;
            if (!resume && payload.engineDir) await connectLocal();
            assets = await runEnhancement() ?? await runWorkflow();
          }
          signal.throwIfAborted();
          controller.completed = true;
          await saveState('done', { error: null, assets: assets.map(asset => asset.id), outputReceipt: undefined });
          await releaseJobMedia(job);
          if (JSON.parse(job.detail).enhancement) await fs.rm(batchDirectory(job), { recursive: true, force: true }).catch(() => {});
        } else {
          if (job.kind === 'preview' && !previewMatchesTimeline(job.project_id, payload)) {
            await saveState('interrupted', obsoletePreview);
            return;
          }
          await saveState('rendering', {
            progress: 0, error: null, videoTrimVersion: 1, frameTimingVersion: 1, captionLayoutVersion: 1, colorPipelineVersion: 1,
            audioSampleTimingVersion: 1,
          });
          const output = renderOutput(job, payload.snapshot);
          const file = await withStorage(() => {
            let lastProgress = 0;
            return services.exportVideo(payload.snapshot, {
              signal, format: payload.format, resolution: payload.resolution, fps: payload.fps, preview: job.kind === 'preview', output,
              onProgress: progress => {
                if (progress - lastProgress < 0.05 && progress !== 1) return;
                lastProgress = progress;
                emit({ id: job.id, projectId: job.project_id, status: 'rendering', progress });
              },
            });
          });
          controller.completed = true;
          await withStorage(() => recordRender(job, payload, file));
          cleanPreviewFiles(job, payload, file);
        }
      } catch (error) {
        if (exiting || controller.cancelling) return;
        const lost = job.kind === 'comfy' && (error.code === 'COMFY_DISCONNECTED' ||
          ['preparing', 'queued'].includes(job.status) && services.isTemporaryConnectionFailure(error) ||
          controller.submitting && !error.status);
        const status = error.code === 'COMFY_PROMPT_MISSING' ? 'interrupted' : lost ? 'disconnected' : 'failed';
        const message = lost && error.code !== 'COMFY_DISCONNECTED'
          ? '与 ComfyUI 的连接中断，请在服务恢复后重试恢复任务。' : error.message;
        const outputUnavailable = job.status === 'collecting' && (error.status === 404 || error.code === 'COMFY_NO_OUTPUT');
        const submissionPending = JSON.parse(job.detail).submissionPending;
        if (outputUnavailable) {
          await engine.forgetPromptCompletion(payload.engineDir, job.prompt_id);
          if (exiting || controller.cancelling) return;
        }
        try {
          await saveState(status, {
            error: message, ...(outputUnavailable && { outputReceipt: undefined }),
            ...(submissionPending && !lost && { submissionPending: undefined }),
            ...(submissionPending && !controller.submitting && !lost && { remoteStatusUnknown: true }),
          });
          if (job.kind === 'comfy' && !lost && !exiting && !controller.cancelling) {
            await releaseJobMedia(job, { preserveOutput: Boolean(completedPromptOutputs(job)) });
          }
        }
        catch (failure) { if (!signal.aborted) throw failure; }
      } finally {
        if (!controller.cancelling) {
          active.delete(job.id);
          if (lane) finishGeneration(lane, job);
          else {
            rendering = false;
            renderNext();
          }
        }
      }
    })();

    async function verifyRegisteredOutputs() {
      const assets = registeredOutputs(job, payload.outputKinds);
      for (const asset of assets) {
        if (await assetFileState(asset, signal) !== 'ready') return null;
      }
      return assets.length ? assets : null;
    }

    async function connectLocal() {
      const instance = managedInstance();
      if (instance?.dir === payload.engineDir) payload.url = instance.url;
      else {
        if (!connectManaged) throw new Error('请启动该任务使用的本地引擎');
        await saveState('preparing', { error: null });
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        try { payload.url = await Promise.race([connectManaged(payload.engineDir), aborted]); }
        finally { signal.removeEventListener('abort', onAbort); }
      }
      signal.throwIfAborted();
      await saveState('preparing', { url: payload.url, error: null, position: null });
    }

    function inputAsset(role) {
      const asset = store.inputAsset(job.project_id, payload.assetInputs[role]);
      if (payload.assetRevisions && asset.revision !== payload.assetRevisions[role]) {
        throw new Error('原任务使用的素材已重新定位，请从项目重新提交生成');
      }
      return asset;
    }

    function upload(asset, owner, attempt) {
      const tag = payload.engineDir ? uploadTag(owner, attempt) : attempt;
      return services.uploadAsset(payload.url, asset, tag, signal);
    }

    async function releaseAttempt(promptId, clientId) {
      if (!payload.engineDir) return;
      const attempt = clientId || promptId;
      if (attempt) {
        await Promise.all([
          cleanManaged(() => removeUploads(payload.engineDir, new Set([job.id]), attempt)),
          cleanManaged(() => removeOutputs(payload.engineDir, new Set([job.id]), attempt)),
        ]);
      }
      await engine.forgetPromptCompletion(payload.engineDir, promptId);
    }

    async function preflightBeforeMedia() {
      if (payload.engineDir && (!payload.url || managedInstance()?.url !== payload.url)) await connectLocal();
      if (job.status !== 'preparing') await saveState('preparing', { error: null, position: null });
      if (checkedUrl === payload.url) return;
      if (!payload.engineDir && mpsVideo) {
        const current = new Set(Object.values(payload.workflow).map(node => node.class_type));
        const extra = [...new Set(Object.values(mpsVideo).map(node => node.class_type))].filter(type => !current.has(type));
        workflow = await services.hasMpsVideoNodes(payload.url, extra, signal) ? mpsVideo : payload.workflow;
      }
      const placeholders = Object.fromEntries(uploadedRoles.map(role => [role, '']));
      const prompt = services.buildPrompt(workflow, mapping, { ...payload.values, ...placeholders });
      await services.preflight(payload.url, prompt, mapping, { signal, defer: uploadedRoles });
      checkedUrl = payload.url;
    }

    async function runWorkflow() {
      const reusedBindings = [];
      const outputs = await runPrompt(resume, job.id, async () => {
        const values = { ...payload.values };
        for (const role of uploadedRoles) {
          signal.throwIfAborted();
          const asset = inputAsset(role);
          await requireAssetFile(asset, signal);
          if (!payload.batchId) values[role] = await upload(asset, job.id, payload.engineDir ? store.id() : job.id);
          else {
            const stat = await fs.stat(asset.path);
            const key = JSON.stringify([payload.url, asset.id, asset.revision, asset.path, stat.size, stat.mtimeMs]);
            if (!lane.uploads.has(payload.batchId)) lane.uploads.set(payload.batchId, new Map());
            const uploads = lane.uploads.get(payload.batchId);
            if (uploads.has(key)) reusedBindings.push(payload.mapping[role]);
            else {
              const attempt = store.id();
              uploads.set(key, payload.engineDir ? await upload(asset, payload.batchId, attempt) :
                await services.uploadAsset(payload.url, asset, payload.batchId + '-' + attempt, signal));
            }
            values[role] = uploads.get(key);
          }
          await requireAssetFile(asset, signal);
        }
        return values;
      }, error => {
        const stale = error.unavailable?.some(missing => reusedBindings.some(binding =>
          binding && String(binding.node) === missing.node && binding.input === missing.input));
        if (stale) lane.uploads.delete(payload.batchId);
        return stale;
      });
      return withStorage(() => services.collect(payload.url, outputs, job.project_id, {
        jobId: job.id, kinds: payload.outputKinds, signal, requireVisibleVideo: Boolean(mpsVideo),
      }));
    }

    async function runEnhancement() {
      if (!isBuiltInEnhancement(payload.workflow, payload.mapping)) return null;
      if (managedMps) {
        workflow = {
          ...workflow, '4': { ...workflow['4'], class_type: 'iModuReelMpsUpscale' },
        };
      }
      let batch = payload.enhancement;
      if (!batch && resume) return null;
      const directory = batchDirectory(job);
      if (!batch) await preflightBeforeMedia();
      const source = inputAsset('sourceVideo');
      await requireAssetFile(source, signal);
      const registered = store.assets(job.project_id).find(asset => asset.job_id === job.id && asset.output_key === batchOutputKey);
      if (registered && await withStorage(() => assetFileState(registered, signal)) === 'ready') return [registered];
      let details = !batch?.colorPipelineVersion ? await media.probe(source.path, signal) : null;
      if (batch && details?.color.hdr) {
        // An unfinished batch from an older version contains unconverted HDR data.
        const previousPrompt = job.prompt_id;
        await saveState('preparing', { enhancement: null, position: null, outputReceipt: undefined }, { prompt_id: null });
        await fs.rm(directory, { recursive: true, force: true });
        await releaseAttempt(previousPrompt, batch.clientId);
        batch = null;
      }
      if (!batch) {
        // A variable-rate clip's reported average can be lower than its capture cadence.
        const nominal = details.nominalFps;
        const fps = nominal && nominal <= 120 ? Math.max(details.fps ?? 0, nominal) : details.fps;
        const batchSize = media.enhancementBatchSize({ ...details, fps });
        batch = await withStorage(async () => {
          try {
            const videoStart = await media.enhancementVideoStart(source.path, signal);
            const segments = await media.splitEnhancement(source.path, directory, { ...details, batchSize, fps }, signal);
            for (const segment of segments) await saveSegmentChecksum(path.join(directory, segment.file), signal);
            await requireAssetFile(source, signal);
            return { fps, videoStart, sourceDuration: details.duration, segments, index: 0, colorPipelineVersion: 1 };
          } catch (error) {
            await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            throw error;
          }
        });
        await saveState('preparing', { enhancement: batch });
      }

      await withStorage(() => fs.mkdir(directory, { recursive: true }));
      let firstFrame = 0;
      const segments = batch.segments.map((segment, index) => {
        const result = { ...segment, index, firstFrame, output: segment.file.replace('source-', 'enhanced-') };
        firstFrame += segment.frames;
        return result;
      });
      // Reclaim the remote prompt before submitting a replacement for a damaged earlier segment.
      const pending = resume && job.prompt_id ? segments[batch.index] : undefined;
      const order = pending ? [pending, ...segments.filter(segment => segment !== pending)] : segments;
      for (const segment of order) {
        signal.throwIfAborted();
        const destination = path.join(directory, segment.output);
        if (await withStorage(() => enhancementSegmentReady(destination, segment.frames, signal))) continue;
        const continuePrompt = segment === pending;
        const clientId = continuePrompt ? batch.clientId : store.id();
        if (!continuePrompt) {
          const previousPrompt = job.prompt_id;
          const previousClient = batch.clientId;
          batch = { ...batch, index: segment.index, clientId };
          await saveState('preparing', { enhancement: batch, outputReceipt: undefined }, { prompt_id: null });
          await releaseAttempt(previousPrompt, previousClient);
        }
        const outputs = await runPrompt(continuePrompt, clientId, async () => {
          const file = path.join(directory, segment.file);
          if (!await enhancementSegmentReady(file, segment.frames, signal)) {
            const partial = file + '.repair.mp4';
            try {
              await requireAssetFile(source, signal);
              details ??= await media.probe(source.path, signal);
              await fs.mkdir(directory, { recursive: true });
              const { frames, firstFrame } = segment;
              await media.rebuildEnhancementSegment(source.path, partial, { ...details, fps: batch.fps, frames, firstFrame }, signal);
              if (await media.countVideoFrames(partial, signal) !== frames) throw new Error(`未能恢复第 ${segment.index + 1} 段源视频`);
              await requireAssetFile(source, signal);
              await saveSegmentChecksum(file, signal, partial);
              await fs.rename(partial, file);
            } finally {
              await fs.rm(partial, { force: true }).catch(() => {});
            }
          }
          return { sourceVideo: await upload({ kind: 'video', path: file }, job.id, clientId) };
        });
        const records = services.outputRecords(outputs);
        const mp4 = [...records].find(([, filename]) => path.extname(filename).toLowerCase() === '.mp4');
        if (!mp4) throw Object.assign(new Error(`第 ${segment.index + 1} 段增强未返回可用的 MP4`), { code: 'COMFY_NO_OUTPUT' });
        const partial = destination + '.partial';
        await withStorage(async () => {
          try {
            await services.downloadOutput(payload.url, mp4[0], partial, signal);
            if (await decodedSegmentFrames(partial, signal) !== segment.frames) {
              throw Object.assign(new Error(`第 ${segment.index + 1} 段增强结果无法解码或帧数与源视频不一致，请重试该段`), { code: 'COMFY_NO_OUTPUT' });
            }
            await saveSegmentChecksum(destination, signal, partial);
            await fs.rename(partial, destination);
          } finally {
            await fs.rm(partial, { force: true }).catch(() => {});
          }
        });
      }

      const lastPrompt = job.prompt_id;
      await saveState('collecting', { enhancement: { ...batch, index: batch.segments.length }, outputReceipt: undefined }, { prompt_id: null });
      await releaseAttempt(lastPrompt, batch.clientId);
      const file = path.join(directory, 'enhanced.mp4');
      const enhanced = segments.map(({ output, frames }) => ({ file: output, frames }));
      await requireAssetFile(source, signal);
      await withStorage(async () => {
        try { await media.joinEnhancement(source.path, directory, enhanced, batch, file, signal); }
        catch (error) {
          await fs.rm(file, { force: true }).catch(() => {});
          throw error;
        }
      });
      await requireAssetFile(source, signal);
      const expectedFrames = enhanced.reduce((total, segment) => total + segment.frames, 0);
      if (await media.countVideoFrames(file, signal) !== expectedFrames) throw new Error('合并后帧数与源视频不一致，请重试合并');
      const result = {
        src: file, name: path.parse(source.name).name + '-增强.mp4', origin: 'comfy',
        ...await media.probe(file, signal), jobId: job.id, outputKey: batchOutputKey, restoreId: registered?.id,
      };
      return withStorage(() => store.addMedia(job.project_id, [result], signal));
    }

    async function runPrompt(continuePrompt, clientId, prepareValues, resetUploadedInputs) {
      let stopProgress;
      try {
        let outputs = continuePrompt ? completedPromptOutputs(job) : null;
        if (!continuePrompt) {
          await preflightBeforeMedia();
          const build = async () => services.buildPrompt(workflow, mapping, await withStorage(prepareValues));
          let prompt = await build();
          if (uploadedRoles.length) {
            try {
              await services.preflight(payload.url, prompt, {}, { signal });
            } catch (error) {
              if (!resetUploadedInputs?.(error)) throw error;
              prompt = await build();
              await services.preflight(payload.url, prompt, {}, { signal });
            }
          }
          signal.throwIfAborted();
          await saveState('queued', { outputReceipt: undefined, submissionPending: !payload.engineDir || undefined }, { prompt_id: clientId });
          stopProgress = watchProgress(clientId);
          // Keep observing submitting requests while cancelling in case the server accepts them.
          controller.submitting = true;
          const managed = Boolean(payload.engineDir);
          const prepared = managed ? scopeOutputs(prompt, job.id, clientId) : prompt;
          const result = await services.submitPrepared(payload.url, prepared, { promptId: clientId, keepOutputs: managed });
          controller.submitting = false;
          await saveState('queued', { submissionPending: undefined }, { prompt_id: result.prompt_id });
        } else if (outputs) {
          if (payload.engineDir && managedInstance()?.url !== payload.url) await connectLocal();
        } else {
          if (!job.prompt_id || payload.engineDir && managedInstance()?.url !== payload.url) {
            throw Object.assign(new Error('找不到可回收的原任务产物，请重新定位原素材或重试生成'), { code: 'COMFY_PROMPT_MISSING' });
          }
          stopProgress = watchProgress(clientId);
        }
        signal.throwIfAborted();
        outputs ??= await services.waitPrompt(payload.url, job.prompt_id, {
          signal,
          isManagedEngineRunning: payload.engineDir ? () => managedInstance()?.url === payload.url : undefined,
          onAccepted: JSON.parse(job.detail).submissionPending
            ? promptId => saveState(job.status, { submissionPending: undefined }, { prompt_id: promptId }) : undefined,
          onStatus: async ({ state, position }) => {
            if (job.status !== state || JSON.parse(job.detail).position !== (position ?? null)) {
              await saveState(state, { position: position ?? null });
            }
          },
        });
        signal.throwIfAborted();
        const files = [...services.outputRecords(outputs).keys()].map(key => Object.fromEntries(new URLSearchParams(key)));
        await saveState('collecting', { error: null, position: null, outputReceipt: { promptId: job.prompt_id, files } });
        return outputs;
      } finally {
        stopProgress?.();
      }
    }

    function watchProgress(clientId) {
      let lastUpdate = 0;
      let lastNode;
      return services.observeComfyProgress(payload.url, clientId, () => job.prompt_id, step => {
        if (signal.aborted || step.node === lastNode && Date.now() - lastUpdate < 250 && step.value < step.max) return;
        lastUpdate = Date.now();
        lastNode = step.node;
        emit({ id: job.id, projectId: job.project_id, status: 'running', step });
      });
    }
    controller.execution.catch(error => console.error('Task persistence failed', error));
    return job;
  }

  function renderNext() {
    if (rendering || exiting || !renderQueue.length) return;
    rendering = true;
    launch(renderQueue.shift());
  }

  function queueRender(job) {
    renderQueue.push(job);
    emit({ id: job.id, projectId: job.project_id, status: 'queued' });
    renderNext();
    return job;
  }

  function start(projectId, kind, payload) {
    const job = store.addJob(projectId, kind, payload);
    if (kind === 'comfy') queueGeneration(job);
    else queueRender(job);
    return job;
  }

  function startGeneration(projectId, payloads) {
    const batchId = store.id();
    const jobs = store.addJobs(projectId, 'comfy', payloads.map(payload => ({ ...payload, batchId })));
    const lanes = new Set(jobs.map(job => queueGeneration(job, { pump: false })));
    for (const lane of lanes) pumpGeneration(lane);
    return jobs;
  }

  function get(jobId) {
    const job = store.one('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) throw new Error('任务不存在');
    return job;
  }

  function resume(jobId) {
    const job = get(jobId);
    store.editableProject(job.project_id);
    const continueStorage = storageWaiters.get(jobId);
    if (continueStorage) {
      continueStorage();
      return job;
    }
    if (active.has(jobId) || cancelling.has(jobId) || recovering.has(jobId)) return job;
    if (job.kind !== 'comfy' || !resumable.has(job.status)) {
      throw new Error('该任务没有可恢复的 ComfyUI 提交记录');
    }
    const payload = JSON.parse(job.detail);
    if (job.prompt_id && payload.engineDir && managedInstance()?.url !== payload.url &&
        !completedPromptOutputs(job)) {
      patch(job, 'interrupted', { error: '本地引擎已重启，请重试生成' });
      void releaseJobMedia(job);
      pumpGeneration(generationLane(payload));
      return job;
    }
    const resumePrompt = Boolean(job.prompt_id);
    patch(job, 'queued', { error: null, position: null });
    queueGeneration(job, { resume: resumePrompt, priority: true });
    return job;
  }

  function stopTracking(jobId) {
    const job = get(jobId);
    store.editableProject(job.project_id);
    if (job.kind !== 'comfy' || job.status !== 'disconnected' || active.has(jobId) || cancelling.has(jobId)) {
      throw new Error('当前任务无法停止跟踪，请在等待恢复时重试');
    }
    const lane = generationLane(JSON.parse(job.detail));
    const waiting = lane.pending.filter(entry => entry.job.project_id === job.project_id && !entry.job.prompt_id && !entry.resume);
    const stopped = [job, ...waiting.map(entry => entry.job)].map(item => {
      const error = item.id !== jobId ? '原引擎的等待队列已停止。可使用当前引擎重试。'
        : item.prompt_id ? '已停止本地跟踪，远端任务状态未知。可使用当前引擎重试。'
          : '已停止等待原引擎。可使用当前引擎重试。';
      return { ...item, status: 'interrupted', detail: JSON.stringify({ ...JSON.parse(item.detail),
        error, position: null, useCurrentEngine: true, remoteStatusUnknown: Boolean(item.prompt_id) }) };
    });
    store.interruptJobs(stopped);
    const ids = new Set(stopped.map(item => item.id));
    lane.pending = lane.pending.filter(entry => !ids.has(entry.job.id));
    lane.paused.delete(jobId);
    for (const entry of waiting) dropUnusedUploads(lane, entry.batchId);
    for (const item of stopped) emit({ id: item.id, projectId: item.project_id, status: item.status });
    notifyQueue(lane, job.project_id);
    pumpGeneration(lane);
    return stopped[0];
  }

  function retry(jobId, target, acceptedReplacements, preferCurrentEngine = false) {
    const job = get(jobId);
    const project = store.editableProject(job.project_id);
    const payload = JSON.parse(job.detail);
    const missingExport = job.kind === 'export' && job.status === 'done' && !media.hasRenderFile(payload.file);
    if ((!missingExport && !retryable.has(job.status)) ||
        (job.kind === 'comfy' ? !payload.workflow && !payload.workflowRef : !payload.snapshot)) {
      throw new Error('该任务没有可重试的参数快照，请重新提交');
    }
    if (job.kind === 'comfy' && (active.has(jobId) || releasingMedia.has(jobId))) {
      throw new Error('生成任务正在收尾，请稍后重试');
    }
    if (job.kind === 'preview') {
      const current = store.project(project.id, { includeWorkflow: false });
      const settings = current.production.exportSettings ?? defaultRenderSettings(current.template_id);
      return start(project.id, 'preview', { ...settings, snapshot: createRenderSnapshot(current) });
    }
    const useCurrentEngine = preferCurrentEngine || payload.useCurrentEngine === true;
    if (useCurrentEngine) {
      if (!target) throw new Error('请设置此设备的生成引擎后重试');
      if (preferCurrentEngine && !canRetryOnCurrentEngine(job, target)) throw new Error('当前引擎与原任务一致，请选择其他引擎');
      delete payload.url;
      delete payload.engineDir;
      Object.assign(payload, target);
      delete payload.useCurrentEngine;
    }
    const sameAttempt = !useCurrentEngine && job.status !== 'cancelled';
    const savedOutput = sameAttempt && Boolean(completedPromptOutputs(job));
    if (sameAttempt && (savedOutput || payload.enhancement)) {
      patch(job, 'queued', { error: null, position: null, ...(!savedOutput && { outputReceipt: undefined }) },
        { prompt_id: savedOutput ? job.prompt_id : null });
      queueGeneration(job, { resume: savedOutput, priority: savedOutput });
      return job;
    }
    for (const key of ['error', 'position', 'assets', 'removedAssetCount', 'file', 'progress', 'enhancement', 'batchId',
      'remoteStatusUnknown', 'outputReceipt', 'submissionPending']) delete payload[key];
    if (payload.snapshot) return retryRender(job, project, payload, acceptedReplacements);
    return start(job.project_id, job.kind, payload);
  }

  async function retryRender(job, project, payload, acceptedReplacements) {
    const catalog = project.template_id === 'enhance'
      ? store.project(project.id, { includeWorkflow: false }).assets : store.assets(project.id);
    const available = new Map(catalog.map(asset => [asset.id, asset]));
    const used = new Set(payload.snapshot.tracks.flatMap(track => track.clips.map(clip => clip.asset_id)));
    const replacements = [];
    const sources = [];
    for (const asset of payload.snapshot.assets) {
      if (!used.has(asset.id)) continue;
      const current = available.get(asset.id);
      const samePath = current?.path === asset.path;
      const sameContent = asset.sha256 && current?.sha256
        ? asset.sha256 === current.sha256 : (asset.revision ?? 0) === (current?.revision ?? 0);
      if ((!samePath || sameContent) && await assetFileState(asset) === 'ready') {
        if (samePath) store.requireEnhancementReview(current);
        sources.push(asset);
        continue;
      }
      await requireAssetFile(current);
      store.requireEnhancementReview(current);
      if (!sameContent) replacements.push({ id: current.id, name: asset.name || current.name, revision: current.revision });
      sources.push(current);
    }
    if (replacements.length && !isDeepStrictEqual(replacements, acceptedReplacements)) return { replacements };
    if (store.editableProject(project.id).dir !== project.dir) throw new Error('项目目录已更新，请重新提交导出');
    const latest = new Map(store.assets(project.id).map(asset => [asset.id, asset]));
    if (sources.some(source => {
      const previous = available.get(source.id);
      const current = latest.get(source.id);
      return previous?.path !== current?.path || previous?.revision !== current?.revision;
    })) throw new Error('素材已更新，请重新提交导出');
    payload.snapshot.assets = sources;
    return start(project.id, job.kind, payload);
  }

  async function cancel(jobId) {
    const job = get(jobId);
    if (!(activeStates.has(job.status) || job.status === 'disconnected')) throw new Error('该任务已结束');
    if (cancelling.has(jobId)) throw new Error('正在取消该任务');
    if (recovering.has(jobId)) throw new Error('任务正在恢复，请继续保存任务记录。');
    const controller = active.get(jobId);
    if (controller?.completed) throw new Error('任务产物已生成，请继续保存任务记录。');
    const payload = JSON.parse(job.detail);
    const lane = job.kind === 'comfy' ? generationLane(payload) : null;
    const pending = lane?.pending.findIndex(entry => entry.job.id === jobId) ?? -1;
    if (pending !== -1 && !job.prompt_id) {
      patch(job, 'cancelled', { error: null });
      const [entry] = lane.pending.splice(pending, 1);
      dropUnusedUploads(lane, entry.batchId);
      await releaseJobMedia(job);
      if (payload.enhancement) await fs.rm(batchDirectory(job), { recursive: true, force: true }).catch(() => {});
      pumpGeneration(lane);
      return job;
    }
    const waiting = renderQueue.findIndex(queued => queued.id === jobId);
    if (waiting !== -1) {
      patch(job, 'cancelled', { error: null });
      renderQueue.splice(waiting, 1);
      return job;
    }
    if (pending !== -1) lane.pending.splice(pending, 1);
    cancelling.add(jobId);
    try {
      if (controller) {
        controller.cancelling = true;
        controller.abort.abort(new Error('任务已取消'));
        await controller.execution;
      }
      const current = get(jobId);
      if (current.status === 'done') return current;
      const { url, enhancement, engineDir, submissionPending } = JSON.parse(current.detail);
      let safelyStopped = !current.prompt_id || Boolean(completedPromptOutputs(current));
      if (lane && url && !safelyStopped) {
        try {
          if (submissionPending) {
            const original = await services.findPrompt(url, current.prompt_id, { signal: shutdown.signal, matchClientId: true });
            if (!original) throw new Error('无法确认原任务的服务端编号。可恢复任务继续查找，或在原实例中核对状态。');
            await withStorageRetry(current, shutdown.signal,
              () => patch(current, current.status, { submissionPending: undefined }, { prompt_id: original.promptId }));
          }
          safelyStopped = await services.cancelPrompt(url, current.prompt_id, { waitForStop: Boolean(engineDir) });
        }
        catch (error) {
          await withStorageRetry(current, shutdown.signal,
            () => patch(current, 'disconnected', { error: '未能取消 ComfyUI 任务：' + error.message }));
          throw error;
        }
      }
      const cancellation = {
        error: null, outputReceipt: undefined, submissionPending: undefined,
        ...(engineDir && !safelyStopped && { remoteStatusUnknown: true }),
      };
      await withStorageRetry(current, shutdown.signal, () => patch(current, 'cancelled', cancellation));
      if (safelyStopped) await releaseJobMedia(current);
      if (enhancement) await fs.rm(batchDirectory(current), { recursive: true, force: true }).catch(() => {});
      return current;
    } finally {
      cancelling.delete(jobId);
      active.delete(jobId);
      if (lane?.inFlight?.job.id === jobId) finishGeneration(lane, job);
      else if (lane) pumpGeneration(lane);
      else if (controller) {
        rendering = false;
        renderNext();
      }
    }
  }

  function saveRecoveredState(job, write, afterSave) {
    try { write(); }
    catch (error) {
      if (!isStorageFull(error)) throw error;
      recovering.add(job.id);
      const { signal } = shutdown;
      void waitForStorage(job, signal).then(() => withStorageRetry(job, signal, write)).then(afterSave).catch(failure => {
        if (!signal.aborted) console.error('Unable to save recovered task', failure);
      }).finally(() => recovering.delete(job.id));
      return;
    }
    afterSave?.();
  }

  function recover() {
    reclaimFinishedMedia();
    const disconnected = store.all("SELECT * FROM jobs WHERE kind = 'comfy' AND status = 'disconnected'");
    for (const job of disconnected) generationLane(JSON.parse(job.detail)).paused.add(job.id);
    const jobs = store.all("SELECT * FROM jobs WHERE status IN ('queued','preparing','running','reconnecting','collecting','rendering') ORDER BY created_at, rowid");
    for (const job of jobs) {
      if (active.has(job.id) || recovering.has(job.id)) continue;
      const payload = JSON.parse(job.detail);
      if (job.kind === 'comfy' && (
        job.status === 'collecting' && registeredOutputs(job, payload.outputKinds).length ||
        completedPromptOutputs(job) ||
        (payload.engineDir ? payload.enhancement && !job.prompt_id && job.status === 'collecting'
          : payload.url && (job.prompt_id || payload.enhancement))
      )) {
        queueGeneration(job, { resume: true, priority: true, pump: false });
      } else if (job.kind === 'comfy' && !job.prompt_id && ['queued', 'preparing'].includes(job.status)) {
        queueGeneration(job, { pump: false });
      }
      else if (job.kind !== 'comfy' && job.status === 'queued' && payload.snapshot) queueRender(job);
      else {
        const file = job.kind !== 'comfy' && job.status === 'rendering' && payload.snapshot
          ? completedRender(job, payload.snapshot) : undefined;
        if (file) saveRecoveredState(job, () => recordRender(job, payload, file), () => cleanPreviewFiles(job, payload, file));
        else saveRecoveredState(job, () => patch(job, 'interrupted', { error: '应用退出时任务尚未完成，可重新提交或重试' }),
          () => void releaseJobMedia(job));
      }
    }
    for (const lane of generationLanes.values()) pumpGeneration(lane);
  }

  function stop() {
    exiting = true;
    shutdown.abort(new Error('应用正在退出'));
    for (const controller of active.values()) controller.abort.abort(new Error('应用正在退出'));
  }

  return { start, startGeneration, queueInfo, storageIssue, resume, retry, cancel, stopTracking, recover, stop };
}

module.exports = { createJobs, canRetryOnCurrentEngine, createRenderSnapshot };
