const { contextBridge, ipcRenderer } = require('electron');

const actions = new Set([
  'allowCloseRequests', 'finishClose',
  'templates', 'presets', 'projects', 'project', 'chooseDir', 'createProject', 'relocateProject', 'importMedia', 'relinkAsset', 'revealAsset', 'prepareAssetPreview',
  'assetCleanupPlan', 'removeUnusedAssets', 'retryAssetTrash',
  'importWorkflow', 'settings', 'saveAI', 'saveComfy', 'checkComfy', 'saveInputs', 'analyze', 'saveAnalysis', 'suggestShots',
  'useAnalysisShots', 'cancelAnalysis',
  'saveEditorDraft', 'saveDraft', 'approveShots', 'loadWorkflow', 'saveWorkflowDraft', 'saveWorkflow', 'preflight', 'generate', 'reviewEnhance',
  'storyboardResults', 'chooseShotResult', 'replaceShotVersion',
  'retryJob', 'resumeJob', 'cancelJob', 'stopTrackingJob', 'addTrack', 'renameTrack', 'moveTrack', 'deleteTrack', 'addClip', 'updateClip', 'splitClip', 'stepTimeline', 'reorderClip', 'deleteClip', 'appendStoryboard', 'export', 'revealRender', 'saveExportSettings',
  'engineInfo', 'installEngine', 'startEngine', 'stopEngine', 'pauseEngine', 'installPresetModels', 'installModelManifest',
  'engineSetupPlan', 'setupLocalEngine', 'connectExternalComfy', 'exportMpsVideoNodes',
  'backupProject', 'restoreProject', 'renameProject', 'archiveProject', 'unarchiveProject',
]);
const events = new Set(['job', 'engineLog', 'saveBeforeClose', 'projectTransfer', 'analysisState', 'generationTargetChanged']);

contextBridge.exposeInMainWorld('api', {
  call: (name, ...args) => {
    if (!actions.has(name)) throw new Error('未知操作');
    return ipcRenderer.invoke(name, ...args);
  },
  on: (name, callback) => {
    if (!events.has(name)) throw new Error('未知事件');
    const listener = (_, value) => callback(value);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
