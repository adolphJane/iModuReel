const { app, BrowserWindow, ipcMain, dialog, shell, protocol, safeStorage } = require('electron');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const services = require('./services.cjs');
const { hasRenderFile, probe, validateExportFrameRate } = require('./media.cjs');
const { assetFileState, assetFingerprint, requireAssetFile, isStorageFull, storageFullMessage } = require('./asset-file.cjs');
const engine = require('./engine.cjs');
const projectBackup = require('./project-backup.cjs');
const { createJobs, canRetryOnCurrentEngine, createRenderSnapshot } = require('./jobs.cjs');
const { projectPresets, presetModels, setupGroups, setupModels } = require('./presets.cjs');
const { templates, resolveTemplate, buildGeneration, inputMediaKinds, validateTemplateMapping } = require('./templates.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const devUrl = 'http://127.0.0.1:5173';
const useDevServer = !app.isPackaged && process.argv.includes('--dev-server');
let win;
let closeState;
let quitRequested = false;
let shuttingDown = false;
const send = (channel, value) => { if (win && !win.isDestroyed()) win.webContents.send(channel, value); };
const jobs = createJobs(event => send('job', event), {
  managedInstance: engine.runningInstance,
  connectManaged: directory => engine.start(directory, text => send('engineLog', text)),
});
const analyses = new Map();
const relocatingProjects = new Set();
const cleaningProjects = new Set();
const pendingProxies = new Map();
const pendingMediaChecks = new Map();
const previewMetadata = new Map();
const proxyShutdown = new AbortController();
let projectTransfer = false;
let proxyQueue = Promise.resolve();

function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    try {
      if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的应用窗口');
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: isStorageFull(error) ? storageFullMessage : error.message || String(error) };
    }
  });
}

const mime = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

async function previewInfo(asset, source) {
  if (asset.kind === 'audio') return null;
  const key = JSON.stringify([asset.path, source.dev, source.ino, source.size, source.mtimeMs, source.ctimeMs]);
  if (!previewMetadata.has(key)) {
    if (previewMetadata.size >= 128) previewMetadata.delete(previewMetadata.keys().next().value);
    const info = probe(asset.path, proxyShutdown.signal).catch(error => {
      previewMetadata.delete(key);
      throw error;
    });
    previewMetadata.set(key, info);
  }
  return previewMetadata.get(key);
}

async function proxyFile(asset, source) {
  const info = await previewInfo(asset, source);
  const stamp = [asset.path, source.size, source.mtimeMs, source.ctimeMs];
  if (info?.color.hdr) stamp.push('hdr-sdr-1');
  const key = createHash('sha256').update(JSON.stringify(stamp)).digest('hex').slice(0, 16);
  const extension = { image: 'png', audio: 'm4a', video: 'mp4' }[asset.kind];
  if (!extension) return null;
  return { file: path.join(app.getPath('userData'), 'media-proxies', `${asset.id}-${key}.${extension}`), info };
}

async function inspectMediaAsset(asset) {
  if (!asset) return 'missing';
  const key = JSON.stringify([asset.path, asset.sha256]);
  if (!pendingMediaChecks.has(key)) {
    const check = assetFileState(asset, proxyShutdown.signal).finally(() => pendingMediaChecks.delete(key));
    pendingMediaChecks.set(key, check);
  }
  return pendingMediaChecks.get(key);
}

async function prepareAssetPreview(id) {
  const asset = store.assetRecord(id);
  const signal = proxyShutdown.signal;
  await requireAssetFile(asset, signal);
  const stat = await fs.promises.stat(asset.path);
  const { file, info } = await proxyFile(asset, stat) ?? {};
  if (!stat.isFile() || !file) throw new Error('素材不可读取，请重新定位');
  if (fs.existsSync(file)) return `media://proxy/${id}`;
  if (!pendingProxies.has(file)) {
    const task = proxyQueue.then(async () => {
      await requireAssetFile(asset, signal);
      await services.createMediaProxy(asset, file, signal, info);
      try {
        await requireAssetFile(asset, signal);
      } catch (error) {
        await fs.promises.rm(file, { force: true }).catch(() => {});
        throw error;
      }
    }).finally(() => pendingProxies.delete(file));
    proxyQueue = task.catch(() => {});
    pendingProxies.set(file, task);
  }
  await pendingProxies.get(file);
  return `media://proxy/${id}`;
}

async function serveMedia(request) {
  const url = new URL(request.url);
  const entryId = url.pathname.slice(1);
  if (!/^[a-f0-9-]{36}$/i.test(entryId) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
  let file, hdr;
  if (url.hostname === 'asset' || url.hostname === 'proxy') {
    const asset = store.assetRecord(entryId);
    const state = await inspectMediaAsset(asset).catch(() => 'unreadable');
    if (state !== 'ready') return new Response(null, { status: { changed: 409, missing: 404, unreadable: 403 }[state] });
    file = asset.path;
    if (url.hostname === 'proxy' || request.method === 'HEAD' && url.searchParams.get('color') === '1') {
      try {
        const source = await fs.promises.stat(asset.path);
        if (url.hostname === 'proxy') file = (await proxyFile(asset, source))?.file;
        else hdr = Boolean((await previewInfo(asset, source))?.color.hdr);
      } catch {
        return new Response(null, { status: 403 });
      }
    }
  } else if (url.hostname === 'render') {
    const entry = store.one("SELECT detail FROM jobs WHERE id = ? AND kind IN ('preview', 'export') AND status = 'done'", [entryId]);
    file = entry && JSON.parse(entry.detail).file;
  }
  if (!file) return new Response(null, { status: 404 });
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile() || !stat.size) return new Response(null, { status: 404 });
  const headers = new Headers({
    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  });
  if (hdr) headers.set('X-iModuReel-HDR', '1');
  const range = request.headers.get('Range');
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (parsed && (parsed[1] || parsed[2])) {
      if (parsed[1]) {
        start = Number(parsed[1]);
        if (parsed[2]) end = Math.min(end, Number(parsed[2]));
      } else start = Math.max(0, stat.size - Number(parsed[2]));
    } else start = stat.size;
    if (start >= stat.size || start > end) return new Response(null, {
      status: 416, headers: { 'Content-Range': `bytes */${stat.size}` },
    });
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  const body = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { headers, status: range ? 206 : 200 });
}

async function openWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 680,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const window = win;
  const state = closeState = { ready: false, pending: false, allowed: false };
  window.webContents.on('did-start-loading', () => { state.ready = false; });
  window.on('close', event => {
    if (state.allowed || !state.ready || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (state.pending) return;
    state.pending = true;
    window.webContents.send('saveBeforeClose');
  });
  win.on('closed', () => { win = null; });
  if (useDevServer) await win.loadURL(devUrl);
  else await win.loadFile(path.join(__dirname, '../dist/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win?.isMinimized()) win.restore(); win?.focus(); });
  app.whenReady().then(async () => {
    await store.init(app.getPath('userData'));
    protocol.handle('media', serveMedia);
    jobs.recover();
    await openWindow();
    for (const { project_id } of store.all('SELECT DISTINCT project_id FROM asset_trash')) {
      void cleanProjectMedia(project_id).catch(error => console.error('Unable to resume asset cleanup:', error));
    }
    app.on('activate', () => { if (!win && !shuttingDown) void openWindow(); });
  }).catch(error => {
    dialog.showErrorBox('iModuReel 启动失败', isStorageFull(error) ? storageFullMessage : error.message);
    app.quit();
  });
}
app.on('before-quit', () => { quitRequested = true; });
app.on('will-quit', event => {
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of analyses.values()) controller.abort();
  jobs.stop();
  proxyShutdown.abort();
  void engine.stop().catch(error => console.error('Unable to stop ComfyUI:', error)).finally(() => {
    // The window has already saved its drafts and closed by the time will-quit runs.
    setImmediate(() => app.exit());
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const engineSettings = () => store.getSetting('engine') || { dir: path.join(app.getPath('userData'), 'engine') };
function comfySettings() {
  const config = store.getSetting('comfy') || {};
  return {
    configured: Boolean(config.mode || config.url),
    mode: config.mode || 'external', url: config.url || services.DEFAULT_COMFY, localUrl: engine.runningInstance()?.url,
  };
}
function generationTarget(comfy = comfySettings()) {
  return comfy.mode === 'local' ? { engineDir: path.resolve(engineSettings().dir) } : { url: comfy.url };
}

async function comfyConnection() {
  const configured = comfySettings();
  if (configured.mode !== 'local') return { url: configured.url };
  const dir = engineSettings().dir;
  const url = await engine.start(dir, text => send('engineLog', text));
  return { url, engineDir: path.resolve(dir) };
}
function aiPublic() {
  const { apiKey, encryptedKey, ...details } = store.getSetting('ai') || {};
  return { ...details, hasKey: Boolean(apiKey || encryptedKey) };
}
function aiConfig() {
  const { encryptedKey, ...details } = store.getSetting('ai') || {};
  return {
    ...details,
    apiKey: encryptedKey ? safeStorage.decryptString(Buffer.from(encryptedKey, 'base64')) : details.apiKey,
  };
}
function saveAI(value) {
  const previous = store.getSetting('ai') || {};
  const url = value.url?.trim() ? services.baseUrl(value.url) : '';
  const config = {
    url, model: String(value.model || '').trim(), transcriptionModel: String(value.transcriptionModel || '').trim(),
    transcriptionEnabled: value.transcriptionEnabled ?? previous.transcriptionEnabled ?? true,
    vision: Boolean(value.vision),
  };
  if (value.apiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存 API Key');
    config.encryptedKey = safeStorage.encryptString(value.apiKey.trim()).toString('base64');
  } else if (!value.clearKey && url === previous.url) {
    config.encryptedKey = previous.encryptedKey;
    config.apiKey = previous.apiKey;
  }
  store.setSetting('ai', config);
  return aiPublic();
}

async function chooseFiles(options = {}) {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], ...options });
  return result.canceled ? [] : result.filePaths;
}

async function transferProject(operation) {
  if (projectTransfer) throw new Error('已有项目备份或恢复正在进行');
  projectTransfer = true;
  try { return await operation(); }
  finally { projectTransfer = false; }
}

async function cleanProjectMedia(projectId, selection) {
  if (cleaningProjects.has(projectId)) throw new Error('正在清理此项目的素材');
  if (relocatingProjects.has(projectId) || projectTransfer) throw new Error('请等待项目迁移或备份结束，再清理素材');
  if (selection && analyses.has(projectId)) throw new Error('请等待素材分析结束，再清理素材');
  cleaningProjects.add(projectId);
  try {
    const report = selection ? store.removeUnusedAssets(projectId, selection) : { removed: 0, retained: 0 };
    const finished = [];
    const pending = [];
    let trashed = 0;
    for (const item of store.stageAssetTrash(projectId)) {
      try {
        if (item.error) throw new Error(item.error);
        if (item.staged) {
          await shell.trashItem(item.staged);
          trashed++;
        }
        if (item.retained) report.retained++;
        finished.push(item.id);
      } catch (error) {
        pending.push({ name: item.name, reason: error.message });
      }
    }
    store.finishAssetTrash(finished);
    return { ...report, trashed, pending };
  } finally {
    cleaningProjects.delete(projectId);
  }
}

handle('templates', () => templates);
handle('allowCloseRequests', () => { closeState.ready = true; });
handle('finishClose', saved => {
  if (!closeState?.pending) return;
  closeState.pending = false;
  if (!saved) {
    quitRequested = false;
    return;
  }
  closeState.allowed = true;
  setImmediate(() => { if (quitRequested) app.quit(); else win?.close(); });
});
handle('presets', projectId => projectPresets(resolveTemplate(store.editableProject(projectId))));
handle('projects', includeArchived => store.listProjects(includeArchived === true));
handle('project', (id, includeWorkflow = true) => {
  store.editableProject(id);
  const project = store.project(id, { jobDetails: 'summary', includeWorkflow: includeWorkflow !== false });
  project.template = resolveTemplate(project);
  delete project.production.transcriptionCheckpoint;
  project.analysisRunning = analyses.has(id);
  project.timelineHistory = store.timelineHistory(id);
  project.hiddenDialogue = store.hiddenDialogue(id);
  const queued = jobs.queueInfo(id);
  const comfy = comfySettings();
  const currentTarget = comfy.configured ? generationTarget(comfy) : undefined;
  const latestPreview = project.jobs.find(job => job.kind === 'preview' && job.status === 'done');
  project.jobs = project.jobs.map(job => {
    const storageIssue = jobs.storageIssue(job.id);
    if (storageIssue) return { ...job, storageIssue };
    const localQueue = queued.get(job.id);
    if (localQueue) return { ...job, localQueue };
    if (canRetryOnCurrentEngine(job, currentTarget)) return { ...job, retryOnCurrentEngine: true };
    if (job.status === 'done' && (job.kind === 'export' || job === latestPreview) &&
        !hasRenderFile(JSON.parse(job.detail).file)) return { ...job, outputMissing: true };
    return job;
  });
  return project;
});
handle('chooseDir', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
handle('createProject', (name, directory, templateId) => {
  const template = templates.find(item => item.id === templateId);
  if (!template) throw new Error('模板不存在');
  return store.createProject(name, directory, template);
});
handle('renameProject', store.renameProject);
handle('archiveProject', projectId => {
  if (analyses.has(projectId)) throw new Error('请等待分析结束，再归档项目');
  store.archiveProject(projectId);
});
handle('unarchiveProject', store.unarchiveProject);
handle('relocateProject', async projectId => {
  if (relocatingProjects.has(projectId)) throw new Error('正在检查项目目录');
  if (cleaningProjects.has(projectId)) throw new Error('请等待素材清理结束，再重新定位项目目录');
  if (projectTransfer) throw new Error('请等待项目备份或恢复结束，再重新定位项目目录');
  relocatingProjects.add(projectId);
  try {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled) return false;
    if (analyses.has(projectId)) throw new Error('请等待分析结束，再重新定位项目目录');
    const [directory] = result.filePaths;
    let accepted;
    for (;;) {
      const review = await store.relocateProject(projectId, directory, accepted);
      if (!review) return true;
      const names = review.unverified.slice(0, 5).map(asset => asset.name || asset.file).join('、');
      const choice = await dialog.showMessageBox(win, {
        type: 'warning', message: '请确认旧版项目的素材文件',
        detail: `下列 ${review.unverified.length} 个文件缺少可用于核对的原始指纹：${names}。继续前请确认它们是原素材。`,
        buttons: ['取消', '确认并迁移'], defaultId: 0, cancelId: 0,
      });
      if (choice.response !== 1) return false;
      accepted = review.unverified;
    }
  } finally {
    relocatingProjects.delete(projectId);
  }
});
handle('backupProject', projectId => transferProject(async () => {
  if (relocatingProjects.has(projectId)) throw new Error('请等待项目目录检查结束，再备份项目');
  if (cleaningProjects.has(projectId)) throw new Error('请等待素材清理结束，再备份项目');
  const [directory] = await chooseFiles({ title: '选择备份保存目录', properties: ['openDirectory', 'createDirectory'] });
  if (!directory) return null;
  return projectBackup.createBackup(projectId, directory, {
    onProgress: progress => send('projectTransfer', { kind: 'backup', projectId, ...progress }),
  });
}));
handle('restoreProject', () => transferProject(async () => {
  const [file] = await chooseFiles({ title: '选择项目备份记录', filters: [{ name: 'iModuReel 项目备份', extensions: ['json'] }] });
  if (!file) return null;
  const [directory] = await chooseFiles({ title: '选择项目恢复位置', properties: ['openDirectory', 'createDirectory'] });
  if (!directory) return null;
  return projectBackup.restoreBackup(file, directory, {
    onProgress: progress => send('projectTransfer', { kind: 'restore', ...progress }),
  });
}));
handle('importMedia', async projectId => {
  const files = await chooseFiles({ properties: ['openFile', 'multiSelections'] });
  return files.length ? services.importMedia(projectId, files) : null;
});
handle('assetCleanupPlan', store.assetCleanupPlan);
handle('removeUnusedAssets', (projectId, selection) => {
  if (!Array.isArray(selection)) throw new Error('请选择要移除的素材');
  return cleanProjectMedia(projectId, selection);
});
handle('retryAssetTrash', projectId => {
  store.editableProject(projectId);
  return cleanProjectMedia(projectId);
});
handle('relinkAsset', async assetId => {
  const [file] = await chooseFiles();
  if (file) await services.relinkMedia(assetId, file);
});
handle('prepareAssetPreview', prepareAssetPreview);
handle('revealAsset', assetId => {
  const asset = store.one('SELECT path FROM assets WHERE id = ?', [assetId]);
  if (asset && fs.existsSync(asset.path)) shell.showItemInFolder(asset.path);
});
handle('importWorkflow', async () => {
  const [file] = await chooseFiles({ filters: [{ name: 'ComfyUI API JSON', extensions: ['json'] }] });
  if (!file) return null;
  if ((await fs.promises.stat(file)).size > 10 * 1024 * 1024) throw new Error('工作流文件超过 10 MB');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
});
handle('settings', () => ({
  ai: aiPublic(), comfy: comfySettings(), engine: engineSettings(),
  engineSetup: store.getSetting('engineSetup'),
}));
handle('saveAI', saveAI);
handle('saveComfy', url => {
  store.setSetting('comfy', { mode: 'external', url: services.baseUrl(url) });
  send('generationTargetChanged');
  return comfySettings();
});
handle('checkComfy', async url => services.checkComfy(url || (await comfyConnection()).url));
handle('connectExternalComfy', async candidate => {
  if (!candidate?.trim()) throw new Error('请输入 ComfyUI 服务地址');
  const url = services.baseUrl(candidate);
  await services.checkComfy(url);
  store.setSetting('comfy', { mode: 'external', url });
  send('generationTargetChanged');
  return comfySettings();
});
handle('exportMpsVideoNodes', async () => {
  const filename = 'imodureel_mps_ltxv.py';
  const result = await dialog.showSaveDialog(win, {
    title: '导出 MPS 动态镜头兼容节点',
    defaultPath: path.join(app.getPath('downloads'), filename),
    filters: [{ name: 'ComfyUI Python 节点', extensions: ['py'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.copyFile(path.join(__dirname, filename), result.filePath);
  return result.filePath;
});

handle('saveEditorDraft', store.saveEditorDraft);
handle('saveInputs', (projectId, candidate) => {
  const project = store.project(projectId);
  const template = resolveTemplate(project);
  const inputs = {};
  for (const field of template.fields) {
    const value = String(candidate[field] || '').trim();
    if (inputMediaKinds[field] && value) {
      store.inputAsset(projectId, value, [inputMediaKinds[field]], { allowMissing: true });
    }
    inputs[field] = value;
  }
  return store.saveInputs(projectId, template.id, inputs);
});

function currentAnalysisState(projectId, initial) {
  const state = store.production(projectId);
  if (state.inputRevision !== initial.inputRevision || state.analysisRevision !== initial.analysisRevision) {
    throw new Error('分析期间输入或分析内容已修改，请基于当前内容重新运行');
  }
  return state;
}

async function referenceTranscriptionOptions(project, reference, config, signal) {
  if (!reference || config.transcriptionEnabled === false || !config.url) return undefined;
  const fingerprint = reference.sha256 || await assetFingerprint(reference.path, signal);
  const source = { ...reference, sha256: fingerprint };
  const key = createHash('sha256').update(JSON.stringify([
    'mp3-540-v1', fingerprint, services.baseUrl(config.url), config.transcriptionModel || 'whisper-1',
  ])).digest('hex');
  const checkpoint = project.production.transcriptionCheckpoint;
  return {
    savedSegments: checkpoint?.key === key ? checkpoint.segments : undefined,
    async saveSegments(segments) {
      await requireAssetFile(source, signal);
      signal.throwIfAborted();
      currentAnalysisState(project.id, project.production);
      store.saveProduction(project.id, { transcriptionCheckpoint: { key, segments } });
    },
  };
}

function completedTranscription(status) {
  return status === 'used' || status === 'empty';
}

async function withAnalysis(projectId, task) {
  if (analyses.has(projectId)) throw new Error('此项目已有分析任务');
  if (relocatingProjects.has(projectId)) throw new Error('请等待项目目录检查结束，再开始分析');
  store.editableProject(projectId);
  const project = store.project(projectId);
  const template = resolveTemplate(project);
  if (!template.stages.includes('analyze')) throw new Error('此模板版本不包含 AI 分析阶段');
  const controller = new AbortController();
  analyses.set(projectId, controller);
  send('analysisState', projectId);
  try {
    return await task(project, template, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return null;
  } finally {
    analyses.delete(projectId);
    send('analysisState', projectId);
  }
}
handle('cancelAnalysis', projectId => analyses.get(projectId)?.abort());
handle('analyze', projectId => withAnalysis(projectId, async (project, template, signal) => {
  const inputs = project.production.inputs || {};
  if (template.id === 'drama' && !inputs.script && !inputs.referenceVideo) throw new Error('请输入剧本或选择参考视频');
  if (template.id === 'fashion' && (!inputs.product || !inputs.sellingPoints)) throw new Error('请输入商品名称和卖点');
  const config = aiConfig();
  const reference = inputs.referenceVideo ? store.inputAsset(projectId, inputs.referenceVideo, ['video']) : null;
  const productImage = config.vision && inputs.productImage ? store.inputAsset(projectId, inputs.productImage, ['image']) : null;
  const sources = [reference, productImage].filter(Boolean);
  const verifySources = () => Promise.all(sources.map(asset => requireAssetFile(asset, signal)));
  await verifySources();
  const transcription = await referenceTranscriptionOptions(project, reference, config, signal);
  const { shots, ...analysis } = await services.analyze(config, template, {
    script: inputs.script, product: inputs.product, sellingPoints: inputs.sellingPoints,
  }, { reference: reference?.path, productImage: productImage?.path, signal, transcription });
  await verifySources();
  signal.throwIfAborted();
  const state = currentAnalysisState(projectId, project.production);
  store.saveProduction(projectId, {
    analysis, analysisShots: shots,
    analysisInputRevision: state.inputRevision ?? 0,
    analysisRevision: (state.analysisRevision ?? 0) + 1,
    ...(transcription && completedTranscription(analysis.referenceSources?.transcription) && { transcriptionCheckpoint: undefined }),
  });
  return { analysis, shots };
}));
handle('suggestShots', (projectId, recoverTranscription) => withAnalysis(projectId, async (project, template, signal) => {
  const { analysis, inputs = {}, inputRevision = 0, analysisInputRevision = 0 } = project.production;
  if (!analysis) throw new Error('请先完成项目分析');
  if (analysisInputRevision !== inputRevision) throw new Error('分析输入已变更，请重新进行 AI 分析');
  const config = aiConfig();
  const { script, product, sellingPoints, referenceVideo } = inputs;
  const canTranscribe = template.id === 'drama' && referenceVideo && config.transcriptionEnabled !== false &&
    config.url && config.apiKey && config.model;
  const retryMissing = recoverTranscription === true;
  if (retryMissing && (!canTranscribe || !analysis.referenceSources?.transcriptionProgress)) {
    throw new Error('请检查参考视频和语音转写设置，再补转写缺失分段');
  }
  const needsTranscript = canTranscribe && analysis.referenceSources?.transcription === 'used' && !analysis.referenceTranscript;
  const reference = retryMissing || needsTranscript
    ? store.inputAsset(projectId, referenceVideo, ['video'], { allowMissing: !retryMissing }) : null;
  let speech;
  if (reference?.exists) {
    await requireAssetFile(reference, signal);
    const transcription = await referenceTranscriptionOptions(project, reference, config, signal);
    if (retryMissing && !transcription?.savedSegments) {
      throw new Error('转写设置或参考视频已变更，请重新运行 AI 分析');
    }
    speech = await services.transcribeReference(config, reference.path, { signal, hasAlternative: true, ...transcription });
  }
  const revised = speech && (speech.text || retryMissing || completedTranscription(speech.status)) ? {
    ...analysis, referenceTranscript: speech.text || undefined, referenceSources: services.transcriptionSources(analysis.referenceSources, speech),
  } : analysis;
  const shots = await services.suggestShots(config, template, revised, { script, product, sellingPoints }, signal);
  if (reference?.exists) await requireAssetFile(reference, signal);
  signal.throwIfAborted();
  currentAnalysisState(projectId, project.production);
  store.saveProduction(projectId, {
    analysisShots: shots, ...(revised !== analysis && { analysis: revised }),
    ...(completedTranscription(speech?.status) && { transcriptionCheckpoint: undefined }),
  });
  return shots;
}));
handle('useAnalysisShots', projectId => {
  const state = store.production(projectId);
  if (!state.analysisShots?.length || (state.inputRevision ?? 0) !== (state.analysisInputRevision ?? 0)) {
    throw new Error('请先为当前输入和分析生成分镜建议');
  }
  store.saveProduction(projectId, { draftShots: state.analysisShots }, 'shots');
  return state.analysisShots;
});
handle('saveDraft', (projectId, shots) => store.saveProduction(projectId, {
  draftShots: shots === null ? null : store.normalizeShots(shots),
}, 'shots'));
handle('saveAnalysis', (projectId, analysis) => {
  if (typeof analysis.summary !== 'string' || !Array.isArray(analysis.characters) || !Array.isArray(analysis.scenes) ||
      analysis.characters.some(item => typeof item !== 'string') ||
      analysis.scenes.some(item => typeof item?.title !== 'string' || typeof item.description !== 'string')) {
    throw new Error('请检查分析摘要、角色和场次格式');
  }
  const project = store.project(projectId);
  const previous = project.production.analysis;
  const productAppearance = project.template_id === 'fashion' && services.normalizeProductAppearance(analysis.productAppearance);
  const updated = {
    ...previous, summary: analysis.summary, characters: analysis.characters, scenes: analysis.scenes,
    ...(productAppearance ? { productAppearance } : {}),
  };
  if (isDeepStrictEqual(updated, previous)) {
    store.saveEditorDraft(projectId, 'analysis', null);
    return project.production;
  }
  return store.saveProduction(projectId, {
    analysis: updated, analysisShots: [], analysisRevision: (project.production.analysisRevision ?? 0) + 1,
  }, 'analysis');
});
handle('approveShots', (projectId, shots) => store.setShots(projectId, shots, true));
handle('loadWorkflow', id => store.loadWorkflow(id));
handle('saveWorkflowDraft', (id, workflow, mapping) => {
  if (typeof workflow !== 'string' || typeof mapping !== 'string' || workflow.length + mapping.length > 20 * 1024 * 1024) {
    throw new Error('工作流草稿格式无效或内容过大');
  }
  store.saveProduction(id, { workflowDraft: { workflow, mapping } }, 'workflow');
});
handle('saveWorkflow', (id, workflow, mapping) => {
  services.validateWorkflow(workflow, mapping);
  validateTemplateMapping(resolveTemplate(store.editableProject(id)), mapping, workflow);
  store.saveWorkflow(id, workflow, mapping);
});
handle('preflight', async (workflow, mapping, projectId) => {
  if (projectId) {
    services.validateWorkflow(workflow, mapping);
    validateTemplateMapping(resolveTemplate(store.editableProject(projectId)), mapping, workflow);
  }
  return services.preflight((await comfyConnection()).url, workflow, mapping);
});
handle('generate', (id, selectedIds, varySeed = false) => {
  const project = store.project(id);
  const bundle = store.loadWorkflow(id);
  if (!bundle) throw new Error('请先保存工作流和输入映射');
  services.validateWorkflow(bundle.workflow, bundle.mapping);
  const requests = buildGeneration(project, bundle, undefined, selectedIds, varySeed === true);
  const target = generationTarget();
  return jobs.startGeneration(id, requests.map(request => ({ ...request, ...target }))).map(job => job.id);
});
handle('reviewEnhance', async (projectId, assetId, revision) => {
  await requireAssetFile(store.inputAsset(projectId, assetId, ['video']));
  return store.approveEnhancement(projectId, assetId, revision);
});
handle('retryJob', (id, replacements, useCurrentEngine) => {
  const comfy = comfySettings();
  const explicit = useCurrentEngine === true;
  const target = comfy.configured ? generationTarget(comfy) : undefined;
  return jobs.retry(id, target, replacements, explicit);
});
handle('resumeJob', jobs.resume);
handle('cancelJob', jobs.cancel);
handle('stopTrackingJob', jobs.stopTracking);
handle('addTrack', store.addTrack);
handle('renameTrack', store.renameTrack);
handle('moveTrack', store.moveTrack);
handle('deleteTrack', store.deleteTrack);
handle('addClip', async (trackId, input) => {
  const track = store.one('SELECT project_id, kind FROM tracks WHERE id = ?', [trackId]);
  if (track && track.kind !== 'subtitle' && input?.asset_id) {
    const asset = store.assetRecord(input.asset_id);
    if (asset?.project_id === track.project_id) {
      await requireAssetFile(asset, proxyShutdown.signal);
      const current = store.assetRecord(asset.id);
      if (current?.path !== asset.path || current.sha256 !== asset.sha256) throw new Error('素材已更新，请重新选择');
    }
  }
  return store.addClip(trackId, input);
});
handle('updateClip', store.updateClip);
handle('splitClip', (clipId, time, fps) => {
  validateExportFrameRate(fps);
  return store.splitClip(clipId, time, fps);
});
handle('stepTimeline', store.stepTimeline);
handle('reorderClip', store.reorderClip);
handle('deleteClip', store.deleteClip);
handle('appendStoryboard', store.appendStoryboard);
handle('storyboardResults', store.storyboardResults);
handle('chooseShotResult', store.chooseShotResult);
handle('replaceShotVersion', store.replaceShotVersion);
function validateRenderOptions(format, resolution, fps) {
  if (!['landscape', 'portrait', 'square'].includes(format)) throw new Error('请选择有效画幅');
  if (![720, 1080, 2160].includes(resolution)) throw new Error('请选择有效分辨率');
  validateExportFrameRate(fps);
}
handle('saveExportSettings', (projectId, format, resolution, fps = 30) => {
  validateRenderOptions(format, resolution, fps);
  store.saveProduction(projectId, { exportSettings: { format, resolution, fps } });
});
handle('export', (projectId, format, preview, resolution = 720, fps = 30) => {
  const project = store.project(projectId, { includeWorkflow: false });
  validateRenderOptions(format, resolution, fps);
  const job = jobs.start(projectId, preview ? 'preview' : 'export', {
    format, resolution, fps, snapshot: createRenderSnapshot(project),
  });
  return job.id;
});
handle('revealRender', id => {
  const job = store.one("SELECT detail FROM jobs WHERE id = ? AND status = 'done' AND kind = 'export'", [id]);
  if (!job) throw new Error('找不到该成片的导出记录');
  const { file, snapshot } = JSON.parse(job.detail);
  if (!hasRenderFile(file)) {
    throw new Error(snapshot ? '成片文件不可用，可在任务页按原设置重新导出' : '成片文件不可用，请从时间线重新导出');
  }
  shell.showItemInFolder(file);
});
handle('engineInfo', dir => engine.info(dir || store.getSetting('engine')?.dir || path.join(app.getPath('userData'), 'engine')));
handle('engineSetupPlan', async dir => {
  const hardware = await engine.info(dir);
  return {
    ...hardware, groups: setupGroups.map(group => {
      const models = setupModels([group.id]);
      return { id: group.id, name: group.name, downloadBytes: engine.modelDownloadBytes(dir, models) };
    }),
  };
});
handle('pauseEngine', () => engine.pause());
handle('installPresetModels', (dir, projectId, presetId, source) => {
  const template = resolveTemplate(store.editableProject(projectId));
  if (!projectPresets(template).some(item => item.id === presetId)) throw new Error('此模板版本不支持该内置工作流');
  return engine.installModels(
    dir || store.getSetting('engine')?.dir || path.join(app.getPath('userData'), 'engine'),
    presetModels(template.id, presetId, source), text => send('engineLog', text),
  );
});
handle('installModelManifest', async dir => {
  const [file] = await chooseFiles({ filters: [{ name: '模型清单', extensions: ['json'] }] });
  if (!file) return null;
  const entries = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  return engine.installModels(dir, entries, text => send('engineLog', text));
});
handle('installEngine', async (dir, packageIndex, pythonMirror) => {
  const sources = engine.downloadSources({ packageIndex, pythonMirror });
  const installed = await engine.install(dir, text => send('engineLog', text), sources);
  if (comfySettings().mode !== 'local' || path.resolve(engineSettings().dir) === installed.dir) {
    store.setSetting('engine', { dir: installed.dir, ...sources });
  }
  return installed;
});
async function activateLocalEngine(dir, { packageIndex, pythonMirror }) {
  if (shuttingDown) throw new Error('应用正在退出');
  await engine.start(dir, text => send('engineLog', text));
  store.setSettings({
    engine: { dir: path.resolve(dir), packageIndex, pythonMirror },
    comfy: { mode: 'local', url: comfySettings().url },
  });
  send('generationTargetChanged');
  return comfySettings();
}
handle('startEngine', dir => activateLocalEngine(dir, engineSettings()));
handle('setupLocalEngine', async candidate => {
  if (typeof candidate?.dir !== 'string' || !path.isAbsolute(candidate.dir)) throw new Error('请选择本地安装目录');
  const { groups, source, repairRuntime } = candidate;
  const models = setupModels(groups, source);
  const dir = path.resolve(candidate.dir);
  const sources = engine.downloadSources(candidate);
  store.setSetting('engineSetup', { dir, ...sources, groups, source });
  const repair = repairRuntime === true;
  const installed = await engine.setup(dir, repair ? [] : models, text => send('engineLog', text), { ...sources, repairRuntime: repair });
  send('engineLog', '正在启动本地引擎\n');
  return activateLocalEngine(installed.dir, sources);
});
handle('stopEngine', async () => {
  await engine.stop();
  return comfySettings();
});
