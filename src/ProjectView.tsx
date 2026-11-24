import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { call } from './api';
import type { Action, Analysis, Asset, AssetCleanupPlan, AssetCleanupReport, JobEvent, Kind, MediaImportReport, Project, ProjectBackupReport, ProjectEditor, ProjectTransferEvent, Shot, StoryboardResults, TemplateField, Track, Workflow } from './api';
import { Timeline } from './Timeline';
import { useEditorDraft } from './useEditorDraft';
import { useComparisonPlayback } from './useComparisonPlayback';
import { assetIssueText, assetVersion, inspectAsset, inspectAssetPreview } from './assetPreview';
import type { AssetFileIssue } from './assetPreview';

const inputFields: Record<TemplateField, { label: string; kind?: Kind; generation?: boolean }> = {
  script: { label: '文字剧本' },
  product: { label: '商品名称' },
  sellingPoints: { label: '商品卖点与穿搭要求' },
  productImage: { label: '商品图片', kind: 'image', generation: true },
  referenceImage: { label: '画面参考图（可选）', kind: 'image', generation: true },
  referenceVideo: { label: '参考视频（可选）', kind: 'video' },
  sourceVideo: { label: '待增强视频', kind: 'video', generation: true },
};
type WorkbenchTab = 'assets' | 'analysis' | 'generate' | 'timeline' | 'jobs';
const kindLabels = { video: '视频', image: '图片', audio: '音频' };
const statuses: Record<string, string> = {
  queued: '排队', preparing: '准备素材', running: '生成中', reconnecting: '尝试重连', collecting: '下载产物',
  rendering: '渲染中', done: '完成', failed: '失败', interrupted: '已中断', disconnected: '等待恢复', cancelled: '已取消',
};
const active = new Set(['queued', 'preparing', 'running', 'reconnecting', 'collecting', 'rendering', 'disconnected']);
const emptyAnalysis: Analysis = { summary: '', characters: [], scenes: [], sceneCuts: [] };
const emptyAppearance = { color: '', shape: '', texture: '' };
const appearanceFields = [['color', '商品颜色'], ['shape', '款式与轮廓'], ['texture', '可见纹理']] as const;
type RenderReplacement = { id: string; name: string; revision: number };

type BuiltInWorkflow = Workflow & {
  id: string;
  name: string;
  description: string;
  models: { size: number; mirrorUrl?: string }[];
};

function formatModelSize(models: BuiltInWorkflow['models']) {
  const megabytes = models.reduce((bytes, model) => bytes + model.size, 0) / 1e6;
  return megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${megabytes.toFixed(0)} MB`;
}

type AssetRecovery = {
  onIssue: (version: string, issue: AssetFileIssue | null) => void;
  onRelink: (id: string) => void;
};

function AssetPlayer({ asset, videoRef, muted, paired, onIssue, onRelink }: AssetRecovery & {
  asset: Asset; videoRef?: Ref<HTMLVideoElement>; muted?: boolean; paired?: boolean;
}) {
  const [proxy, setProxy] = useState<string>();
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState('');
  const [issue, setIssue] = useState<AssetFileIssue | null>();
  const [hdr, setHdr] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inspection = useRef<AbortController>(null);
  const { id } = asset;
  const version = assetVersion(asset);
  const loadProxy = useCallback(async (signal: AbortSignal) => {
    setError('');
    setConverting(true);
    try {
      const compatible = await call<string>('prepareAssetPreview', id);
      if (!signal.aborted) setProxy(compatible);
    } catch (error) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal.aborted) setConverting(false);
    }
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    inspection.current = controller;
    void inspectAsset(id, controller.signal, true).then(result => {
      if (controller.signal.aborted) return;
      onIssue(version, result.issue);
      setHdr(result.hdr);
      setIssue(result.issue);
      if (result.hdr) void loadProxy(controller.signal);
    }).catch(() => {});
    return () => controller.abort();
  }, [id, version, attempt, onIssue, loadProxy]);
  const source = proxy ?? `media://asset/${asset.id}`;
  const convert = async () => {
    const signal = inspection.current?.signal;
    if (converting || !signal || signal.aborted) return;
    setError('');
    setConverting(true);
    try {
      const result = await inspectAssetPreview(id, signal);
      if (signal.aborted) return;
      onIssue(version, result);
      setIssue(result);
      if (!result) {
        if (proxy) setError('兼容预览无法播放');
        else await loadProxy(signal);
      }
    } catch (issue) {
      if (!signal.aborted) setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      if (!signal.aborted) setConverting(false);
    }
  };
  const retry = () => {
    setIssue(undefined);
    setProxy(undefined);
    setConverting(false);
    setError('');
    setAttempt(previous => previous + 1);
  };
  if (issue === undefined) return <p role="status">正在检查素材…</p>;
  if (issue) return <div role="alert" className="alert error">
    <p>{assetIssueText[issue]}：{asset.name}</p>
    <div className="row">
      <button onClick={() => onRelink(id)}>重新定位或替换</button>
      <button onClick={retry}>重试预览</button>
    </div>
  </div>;
  const onError = () => { if (!error) void convert(); };
  return <>
    {(!hdr || proxy) && (asset.kind === 'image' ? <img src={source} alt={asset.name} onError={onError} />
      : asset.kind === 'audio' ? <audio controls src={source} onError={onError} />
      : <video controls={!paired} preload={paired ? 'auto' : undefined} ref={videoRef} muted={muted}
        aria-label={asset.name} src={source} onError={onError} />)}
    {converting && <p role="status">{hdr ? '正在生成 SDR 预览…' : '正在生成兼容预览…'}</p>}
    {error && <div role="alert" className="alert error">{error}{!proxy && <button onClick={() => void convert()}>重试预览</button>}</div>}
  </>;
}

function comparisonTime(time: number) {
  const milliseconds = Math.round(time * 1000);
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = ((milliseconds % 60000) / 1000).toFixed(3);
  return `${minutes}:${seconds.padStart(6, '0')}`;
}

function SideBySide({ original, result, ...recovery }: AssetRecovery & { original: Asset; result: Asset }) {
  const playback = useComparisonPlayback();
  return <div className="panel preview">
    <div className="grid">
      <div><h3>原视频</h3><AssetPlayer key={assetVersion(original)} asset={original} videoRef={playback.originalRef} paired muted {...recovery} /></div>
      <div><h3>增强结果</h3><AssetPlayer key={assetVersion(result)} asset={result} videoRef={playback.resultRef} paired {...recovery} /></div>
    </div>
    <div className="row">
      <button type="button" disabled={!playback.playing && !playback.ready} onClick={playback.toggle}>
        {playback.playing ? '同时暂停' : '同时播放'}
      </button>
      <input type="range" aria-label="对比播放位置" aria-valuetext={comparisonTime(playback.position)}
        min={0} max={playback.duration} step={0.001} value={playback.position} disabled={!playback.duration}
        onChange={event => playback.seek(Number(event.target.value))} />
      <output>{comparisonTime(playback.position)} / {comparisonTime(playback.duration)}</output>
    </div>
    {playback.error && <p role="alert">{playback.error}</p>}
  </div>;
}

export function ProjectView({ initial, act, editor, configureEngine }: {
  initial: Project;
  act: Action;
  editor: Ref<ProjectEditor>;
  configureEngine?: () => void;
}) {
  const { template } = initial;
  const recovered = initial.editorDrafts;
  const enhance = template.id === 'enhance';
  const fashion = template.id === 'fashion';
  const hasAnalysis = template.stages.includes('analyze');
  const hasStoryboard = !enhance && template.stages.includes('review');
  const hasAnalysisPage = hasAnalysis || hasStoryboard;
  const hasGeneration = template.stages.includes('generate');
  const hasTimeline = template.stages.includes('edit') || template.stages.includes('export');
  const hasShotReferences = template.id === 'drama' && template.fields.includes('referenceImage');
  const hasDialogueAudio = template.id === 'drama';
  const analysisTitle = hasAnalysis ? '分析与分镜' : '分镜审核';
  const tabs: [WorkbenchTab, string][] = [['assets', '项目素材']];
  if (hasAnalysisPage) tabs.push(['analysis', analysisTitle]);
  if (hasGeneration) tabs.push(['generate', enhance ? '画质增强' : '镜头生成']);
  if (hasTimeline) tabs.push(['timeline', '多轨剪辑']);
  tabs.push(['jobs', '任务']);
  const [project, setProject] = useState(initial);
  const [tab, setTab] = useState<WorkbenchTab>(() => {
    if (hasTimeline && recovered?.clip) return 'timeline';
    if (hasGeneration && (recovered?.workflow || recovered?.inputs && !hasAnalysisPage)) return 'generate';
    if (hasAnalysisPage && (recovered?.inputs || recovered?.analysis || recovered?.shots)) return 'analysis';
    return 'assets';
  });
  const savedInputs = useRef(initial.production.inputs ?? {});
  const [inputs, setInputs] = useState(recovered?.inputs ?? savedInputs.current);
  const savedAnalysis = useRef(initial.production.analysis ?? emptyAnalysis);
  const [analysis, setAnalysis] = useState(recovered?.analysis ?? savedAnalysis.current);
  const savedShots = useRef(initial.production.draftShots ?? initial.shots);
  const [shotDraft, setShotDraft] = useState(recovered?.shots ?? savedShots.current);
  const dirtyShots = shotDraft !== savedShots.current;
  const [selectedShots, setSelectedShots] = useState<string[]>([]);
  const savedWorkflow = useRef(initial.production.workflowDraft ?? {
    workflow: initial.workflow ? JSON.stringify(initial.workflow.workflow, null, 2) : '',
    mapping: initial.workflow ? JSON.stringify(initial.workflow.mapping, null, 2) : '{}',
  });
  const [workflow, setWorkflow] = useState(recovered?.workflow?.workflow ?? savedWorkflow.current.workflow);
  const [mapping, setMapping] = useState(recovered?.workflow?.mapping ?? savedWorkflow.current.mapping);
  const [presets, setPresets] = useState<BuiltInWorkflow[]>([]);
  const [presetId, setPresetId] = useState('');
  const [modelSource, setModelSource] = useState('original');
  const [downloading, setDownloading] = useState(false);
  const [modelLog, setModelLog] = useState('');
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [generating, setGenerating] = useState(false);
  const [choosingVersion, setChoosingVersion] = useState(false);
  const [appendingStoryboard, setAppendingStoryboard] = useState(false);
  const appendInFlight = useRef(false);
  const [storyboard, setStoryboard] = useState<StoryboardResults>();
  const [relocating, setRelocating] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<MediaImportReport>();
  const [cleanup, setCleanup] = useState<AssetCleanupPlan>();
  const [cleanupSelection, setCleanupSelection] = useState<string[]>([]);
  const [cleanupReport, setCleanupReport] = useState<AssetCleanupReport>();
  const [cleaning, setCleaning] = useState(false);
  const [backupProgress, setBackupProgress] = useState<ProjectTransferEvent>();
  const [backupReport, setBackupReport] = useState<ProjectBackupReport>();
  const [preview, setPreview] = useState<string>();
  const [voicePreviewShot, setVoicePreviewShot] = useState<string>();
  const [mediaCheckVersion, setMediaCheckVersion] = useState(0);
  const [assetIssues, setAssetIssues] = useState<Record<string, AssetFileIssue>>({});
  const [progress, setProgress] = useState<Record<string, JobEvent>>({});
  const revision = useRef(0);
  const timelineEditor = useRef<ProjectEditor>(null);
  const pid = initial.id;
  const inputsCheckpoint = useEditorDraft(pid, 'inputs', savedInputs.current !== inputs ? inputs : undefined, act);
  const analysisCheckpoint = useEditorDraft(pid, 'analysis', savedAnalysis.current !== analysis ? analysis : undefined, act);
  const shotsCheckpoint = useEditorDraft(pid, 'shots', dirtyShots ? shotDraft : undefined, act);
  const workflowText = useMemo(() => ({ workflow, mapping }), [workflow, mapping]);
  const workflowChanged = workflow !== savedWorkflow.current.workflow || mapping !== savedWorkflow.current.mapping;
  const workflowCheckpoint = useEditorDraft(pid, 'workflow', workflowChanged ? workflowText : undefined, act);
  const preset = presets.find(item => item.id === presetId) ?? presets[0];
  const hasModelMirror = preset?.models.some(model => Boolean(model.mirrorUrl));
  const { inputRevision = 0, analysisInputRevision = 0, reviewedInputRevision = 0 } = project.production;
  const analysisStale = analysisInputRevision !== inputRevision;
  const analysisBusy = startingAnalysis || project.analysisRunning;
  const reviewStale = reviewedInputRevision !== inputRevision;
  const analysisResult = project.production.analysisShots ?? [];
  const referenceSources = analysis.referenceSources;
  const transcriptionProgress = referenceSources?.transcriptionProgress;
  const referenceSourceNames = referenceSources && [
    referenceSources.script && '文字剧本',
    referenceSources.frames > 0 && `参考视频抽帧（${referenceSources.frames} 张）`,
    referenceSources.transcription === 'used' && '语音转写',
    referenceSources.transcription === 'partial' && '部分语音转写',
  ].filter(Boolean).join('、');
  const waitingForStorage = project.jobs.filter(job => job.storageIssue);

  const reload = useCallback(async () => {
    const expected = ++revision.current;
    const fresh = await call<Project>('project', pid, false);
    if (expected === revision.current) setProject(fresh);
  }, [pid]);

  useEffect(() => {
    if (enhance || (tab !== 'generate' && tab !== 'timeline')) return;
    let current = true;
    void call<StoryboardResults>('storyboardResults', pid).then(result => {
      if (current) setStoryboard(result);
    }).catch(error => {
      if (current) setStoryboard({ shots: [], error: error.message });
    });
    return () => { current = false; };
  }, [tab, enhance, pid, project]);

  useEffect(() => {
    let mounted = true;
    if (!initial.workflow && !initial.production.workflowDraft && !recovered?.workflow) void call<Workflow | null>('loadWorkflow', pid).then(bundle => {
      if (!mounted || !bundle) return;
      const contents = { workflow: JSON.stringify(bundle.workflow, null, 2), mapping: JSON.stringify(bundle.mapping, null, 2) };
      savedWorkflow.current = contents;
      setWorkflow(contents.workflow);
      setMapping(contents.mapping);
    }).catch(error => { if (mounted) void act(async () => { throw error; }); });
    if (hasGeneration) void call<BuiltInWorkflow[]>('presets', pid).then(value => {
      if (mounted) setPresets(value);
    }).catch(error => { if (mounted) void act(async () => { throw error; }); });
    return () => { mounted = false; };
  }, [pid, initial.workflow, initial.production.workflowDraft, hasGeneration, recovered?.workflow, act]);

  useEffect(() => window.api.on('job', data => {
    const event = data as JobEvent;
    if (event.projectId !== pid) return;
    setProgress(previous => ({ ...previous, [event.id]: event }));
    if ((event.progress === undefined && !event.step) || event.status === 'done') void reload().catch(() => {});
  }), [pid, reload]);

  useEffect(() => window.api.on('generationTargetChanged', () => {
    void reload().catch(() => {});
  }), [reload]);

  useEffect(() => {
    const unsubscribe = window.api.on('analysisState', projectId => {
      if (projectId === pid) void reload().catch(() => {});
    });
    void reload().catch(() => {});
    return unsubscribe;
  }, [pid, reload]);

  useEffect(() => {
    const persisted = project.production.analysis;
    if (persisted && persisted !== analysis && savedAnalysis.current === analysis) {
      savedAnalysis.current = persisted;
      setAnalysis(persisted);
    }
  }, [project.production.analysis, analysis]);

  useEffect(() => window.api.on('projectTransfer', data => {
    const progress = data as ProjectTransferEvent;
    if (progress.kind === 'backup' && progress.projectId === pid) setBackupProgress(progress);
  }), [pid]);

  useEffect(() => {
    if (!downloading) return;
    return window.api.on('engineLog', chunk => setModelLog(log => (log + String(chunk)).slice(-3000)));
  }, [downloading]);

  const saveInputs = async () => {
    if (savedInputs.current === inputs && project.production.inputs) return;
    await inputsCheckpoint.flush();
    await call('saveInputs', pid, inputs);
    savedInputs.current = inputs;
    await reload();
  };
  const saveAnalysis = async () => {
    if (savedAnalysis.current === analysis) return;
    await analysisCheckpoint.flush();
    await call('saveAnalysis', pid, analysis);
    savedAnalysis.current = analysis;
    await reload();
  };

  const runAnalysis = (operation: 'analyze' | 'suggestShots', recoverTranscription = false) => {
    if (operation === 'analyze' && (project.production.analysis || savedAnalysis.current !== analysis) &&
        !window.confirm('重新分析将替换当前分析和分镜建议。已确认的分镜会保留。是否继续？')) return;
    setStartingAnalysis(true);
    setAnalysisNotice('');
    void act(async () => {
      await saveInputs();
      await saveAnalysis();
      const result = await call(operation, pid, recoverTranscription);
      await reload();
      setAnalysisNotice(result === null ? 'AI 分析已取消。' :
        operation === 'analyze' ? '分析建议已生成。' : recoverTranscription ? '已更新转写和分镜建议。' : '已根据修改后的分析生成分镜建议。');
    }).finally(() => setStartingAnalysis(false));
  };

  const savePendingEdits = async () => {
    if (tab === 'timeline') await timelineEditor.current?.savePendingEdits();
    if ((tab === 'analysis' || tab === 'generate') && savedInputs.current !== inputs) await saveInputs();
    if (tab === 'analysis') {
      if (savedAnalysis.current !== analysis) await saveAnalysis();
      if (dirtyShots) await saveShotDraft();
    }
    if (tab === 'generate' && workflowChanged) {
      await workflowCheckpoint.flush();
      await call('saveWorkflowDraft', pid, workflow, mapping);
      savedWorkflow.current = { workflow, mapping };
    }
  };
  const checkpointPendingEdits = async () => {
    await Promise.all([
      timelineEditor.current?.checkpointPendingEdits(),
      inputsCheckpoint.flush(), analysisCheckpoint.flush(), shotsCheckpoint.flush(), workflowCheckpoint.flush(),
    ]);
  };
  useImperativeHandle(editor, () => ({ savePendingEdits, checkpointPendingEdits }));

  const open = (name: WorkbenchTab) => void act(async () => {
    if (name !== tab) await savePendingEdits();
    await reload();
    setTab(name);
  });

  const saveShotDraft = async () => {
    await shotsCheckpoint.flush();
    await call('saveDraft', pid, shotDraft);
    savedShots.current = shotDraft;
    await reload();
  };

  const importMedia = () => {
    setImporting(true);
    setImportReport(undefined);
    void act(async () => {
      const report = await call<MediaImportReport | null>('importMedia', pid);
      if (!report) return;
      setImportReport(report);
      if (report.imported.length) {
        await reload();
        if (cleanup) setCleanup(await call<AssetCleanupPlan>('assetCleanupPlan', pid));
      }
    }).finally(() => setImporting(false));
  };

  const openCleanup = () => {
    setCleaning(true);
    setCleanupSelection([]);
    setCleanupReport(undefined);
    void act(async () => {
      await checkpointPendingEdits();
      setCleanup(await call<AssetCleanupPlan>('assetCleanupPlan', pid));
    }).finally(() => setCleaning(false));
  };

  const cleanMedia = (selected?: string[]) => {
    if (selected && !window.confirm(`移除所选的 ${selected.length} 项素材？项目内可清理的文件将移至系统回收站。`)) return;
    setCleaning(true);
    setCleanupReport(undefined);
    void act(async () => {
      await checkpointPendingEdits();
      try {
        const report = selected
          ? await call<AssetCleanupReport>('removeUnusedAssets', pid, selected)
          : await call<AssetCleanupReport>('retryAssetTrash', pid);
        setCleanupReport(report);
        setCleanupSelection([]);
      } finally {
        await reload();
        const plan = await call<AssetCleanupPlan>('assetCleanupPlan', pid);
        const candidates = new Set(plan.assets.map(asset => asset.id));
        setCleanupSelection(previous => previous.filter(id => candidates.has(id)));
        setCleanup(plan);
      }
    }).finally(() => setCleaning(false));
  };

  const relinkAsset = (assetId: string) => void act(async () => {
    await call('relinkAsset', assetId);
    await reload();
    setMediaCheckVersion(previous => previous + 1);
  });
  const reportAssetIssue = useCallback((version: string, issue: AssetFileIssue | null) => {
    setAssetIssues(previous => {
      if ((previous[version] ?? null) === issue) return previous;
      const updated = { ...previous };
      if (issue) updated[version] = issue;
      else delete updated[version];
      return updated;
    });
  }, []);
  const assetRecovery = { onIssue: reportAssetIssue, onRelink: relinkAsset };
  function openAsset(asset: Asset) {
    setPreview(asset.id);
    setMediaCheckVersion(previous => previous + 1);
  }

  async function checkAssetBeforeUse(asset: Asset) {
    const issue = await inspectAssetPreview(asset.id);
    reportAssetIssue(assetVersion(asset), issue);
    if (issue) throw new Error(`${assetIssueText[issue]}，请重新定位或替换：${asset.name}`);
  }

  function inputField(key: TemplateField) {
    const { label, kind } = inputFields[key];
    const value = inputs[key] || '';
    const options = kind ? project.assets.filter(asset =>
      asset.kind === kind && asset.origin !== 'comfy' && (asset.exists || asset.id === value)) : [];
    const missing = options.find(asset => !asset.exists);
    return <Fragment key={key}>
      <label>{label}
        {kind ? <select value={value} onChange={event => setInputs(previous => ({ ...previous, [key]: event.target.value }))}>
          <option value="">选择项目素材</option>
          {options.map(asset => <option value={asset.id} key={asset.id}>{asset.name}{!asset.exists && '（缺失）'}</option>)}
        </select> : <textarea rows={key === 'script' ? 7 : 3} value={value}
          onChange={event => setInputs(previous => ({ ...previous, [key]: event.target.value }))} />}
      </label>
      {missing && <div className="row">
        <button aria-label={'重新定位 ' + missing.name} onClick={() => relinkAsset(missing.id)}>重新定位素材</button>
      </div>}
    </Fragment>;
  }

  function editShot(id: string, patch: Partial<Shot>) {
    setShotDraft(shots => shots.map(shot => shot.id === id ? { ...shot, ...patch } : shot));
  }

  const previewed = project.assets.find(asset => asset.id === preview);
  const previewJob = project.jobs.find(job => job.id === previewed?.job_id);
  const sourceSnapshot = previewJob ? JSON.parse(previewJob.detail) : null;
  const sourceRole = sourceSnapshot?.assetInputs?.sourceVideo ? 'sourceVideo' : 'asset';
  const originalId = sourceSnapshot?.assetInputs?.[sourceRole];
  const original = project.assets.find(asset => asset.id === originalId && asset.exists &&
    (asset.revision ?? 0) === (sourceSnapshot?.assetRevisions?.[sourceRole] ?? 0));
  const generateAssets = project.assets.filter(asset => asset.origin === 'comfy');
  const shotReferenceAssets = hasShotReferences ? project.assets.filter(asset => asset.kind === 'image') : [];
  const voiceAssets = hasDialogueAudio ? project.assets.filter(asset => asset.kind === 'audio') : [];
  const approvedShots = project.shots.filter(shot => shot.status === 'approved');
  const pendingShots = dirtyShots || Boolean(project.production.draftShots || project.editorDrafts?.shots);
  const chosen = approvedShots.filter(shot => selectedShots.includes(shot.id));
  const assetsById = new Map(generateAssets.map(asset => [asset.id, asset]));
  const candidateAssets = new Set(storyboard?.shots.flatMap(shot => shot.candidates.map(asset => asset.assetId)));
  const availableResults = storyboard?.shots.filter(group => group.error || group.selectedAssetId || group.candidates.length) ?? [];
  const timelineClips = useMemo(() => new Map(project.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip]))), [project.tracks]);
  const readWorkflow = (): Workflow => ({ workflow: JSON.parse(workflow), mapping: JSON.parse(mapping) });
  const saveWorkflow = async () => {
    const specification = readWorkflow();
    await workflowCheckpoint.flush();
    await call('saveWorkflow', pid, specification.workflow, specification.mapping);
    savedWorkflow.current = { workflow, mapping };
    return specification;
  };
  const submitGeneration = (varySeed: boolean) => {
    setGenerating(true);
    void act(async () => {
      await saveInputs();
      await saveWorkflow();
      try {
        await call<string[]>('generate', pid, chosen.map(shot => shot.id), varySeed);
      } finally {
        await reload();
      }
      setTab('jobs');
    }, '已加入生成队列').finally(() => setGenerating(false));
  };
  const appendStoryboard = () => {
    if (appendInFlight.current) return;
    appendInFlight.current = true;
    setAppendingStoryboard(true);
    void act(async () => {
      await saveInputs();
      await saveWorkflow();
      await call('appendStoryboard', pid);
      await reload();
      setTab('timeline');
    }, '粗剪已加入时间线').finally(() => {
      appendInFlight.current = false;
      setAppendingStoryboard(false);
    });
  };
  const chooseVersion = (shotId: string, assetId: string | null) => {
    setChoosingVersion(true);
    void act(async () => {
      try {
        if (assetId) {
          await saveInputs();
          if (workflowChanged || project.production.workflowDraft) await saveWorkflow();
        }
        await call('chooseShotResult', pid, shotId, assetId);
      } finally {
        await reload();
      }
    }, assetId ? '已采用此镜头版本' : '已恢复自动选择').finally(() => setChoosingVersion(false));
  };

  const replaceTimelineVersion = (shotId: string, assetId: string) => {
    setChoosingVersion(true);
    void act(async () => {
      await saveInputs();
      if (workflowChanged || project.production.workflowDraft) await saveWorkflow();
      await call('replaceShotVersion', pid, shotId, assetId);
      await reload();
    }, '已替换时间线中的镜头版本').finally(() => setChoosingVersion(false));
  };
  const addToTimeline = (asset: Asset) => void act(async () => {
    await checkAssetBeforeUse(asset);
    const kind = asset.kind === 'audio' ? 'audio' : 'video';
    const track = project.tracks.find(track => track.kind === kind) ||
      await call<Track>('addTrack', pid, kind, (kind === 'audio' ? '音频' : '视频') + ' 1');
    const job = project.jobs.find(item => item.id === asset.job_id);
    const generated = job ? JSON.parse(job.detail) : null;
    const planned = generated?.values?.duration;
    const duration = typeof planned === 'number'
      ? asset.kind === 'image' ? planned : asset.kind === 'video' && asset.duration ? Math.min(planned, asset.duration) : undefined
      : undefined;
    await call('addClip', track.id, { asset_id: asset.id, duration });
    await reload();
    setTab('timeline');
  });

  function renderGeneratedAsset(asset: Asset, label?: string, action?: ReactNode) {
    const issue = assetIssues[assetVersion(asset)];
    return <div className="asset" key={asset.id}>
      <span>{asset.name}{label && ` · ${label}`}{issue && ` · ${assetIssueText[issue]}`}</span>
      <div className="row">
        {asset.exists && <button onClick={() => openAsset(asset)}>{enhance ? '对比预览' : '预览'}</button>}
        {issue || !asset.exists ? <button onClick={() => relinkAsset(asset.id)}>
          {asset.exists ? '重新定位或替换' : '重新定位'}
        </button> : <>
          {action}
          {asset.enhancementReviewRequired ? <button onClick={() => void act(async () => {
            await checkAssetBeforeUse(asset);
            try { await call('reviewEnhance', pid, asset.id, asset.revision ?? 0); }
            finally { await reload(); }
          }, '已确认增强结果')}>确认增强结果</button>
            : hasTimeline && <button onClick={() => addToTimeline(asset)}>加入时间线</button>}
        </>}
      </div>
    </div>;
  }

  function retryJob(id: string, useCurrentEngine = false) {
    void act(async () => {
      let accepted: RenderReplacement[] | undefined;
      for (;;) {
        const { replacements } = await call<{ replacements?: RenderReplacement[] }>('retryJob', id, accepted, useCurrentEngine);
        if (!replacements?.length) break;
        const names = replacements.map(asset => asset.name).join('、');
        if (!window.confirm(`以下原素材已丢失：${names}。是否使用当前重新定位的素材重新渲染？`)) return;
        accepted = replacements;
      }
      await reload();
    });
  }

  function renderJob(job: Project['jobs'][number]) {
    const detail = JSON.parse(job.detail);
    const event = progress[job.id];
    const batch = detail.enhancement;
    const missingExport = job.kind === 'export' && job.outputMissing;
    return <div className="asset job" key={job.id}>
      <div><b>{detail.label || ({ export: '导出 MP4', preview: '合成预览', comfy: 'ComfyUI 工作流' }[job.kind])}</b>
        <p>{job.storageIssue ? '等待磁盘空间' : job.localQueue ? `等待提交 · 第 ${job.localQueue.position} 位` : statuses[job.status] || job.status}
          {job.localQueue?.paused ? ' · 前序任务等待重连' : ''}
          {batch && job.status !== 'done' ? ` · 第 ${Math.min(batch.index + 1, batch.segments.length)} / ${batch.segments.length} 段` : ''}
          {job.status === 'queued' && !job.localQueue && detail.position ? ` · 第 ${detail.position} 位` : ''}
          {job.status === 'rendering' && !job.storageIssue ? ` · ${Math.round((event?.progress || 0) * 100)}%` : ''}
          {['running', 'queued'].includes(job.status) && event?.step
            ? ` · 节点 ${event.step.node || '执行中'} ${event.step.value}/${event.step.max}` : ''}
          {job.status === 'done' && detail.assets ? ` · ${detail.assets.length} 项产物` : ''}
          {detail.removedAssetCount ? ` · 已移除 ${detail.removedAssetCount} 项产物` : ''}
        </p>
        {(job.storageIssue || detail.error) && <p className="job-error">{job.storageIssue?.message || detail.error}</p>}
        {missingExport && <p className="job-error">{detail.snapshot
          ? '成片文件不可用，可以按原设置重新导出。' : '成片文件不可用，请从时间线重新导出。'}</p>}</div>
      <div className="row">
        {job.status === 'done' && job.kind === 'export' && !missingExport &&
          <button onClick={() => void act(async () => {
            try { await call('revealRender', job.id); }
            catch (error) { await reload(); throw error; }
          })}>定位成片</button>}
        {missingExport && detail.snapshot && <button onClick={() => retryJob(job.id)}>重新导出</button>}
        {(job.storageIssue || job.status === 'disconnected') && <button onClick={() => void act(async () => {
          await call('resumeJob', job.id);
          await reload();
        })}>{job.storageIssue ? '继续任务' : '恢复任务'}</button>}
        {active.has(job.status) && job.storageIssue?.canCancel !== false &&
          <button onClick={() => void act(async () => { await call('cancelJob', job.id); await reload(); })}>取消任务</button>}
        {!job.storageIssue && job.status === 'disconnected' && <button onClick={() => {
          if (!window.confirm('停止本地跟踪并保留任务记录？此项目在同一引擎上尚未提交的任务会一起中断，已提交的远端任务可能仍在运行。')) return;
          void act(async () => { await call('stopTrackingJob', job.id); await reload(); });
        }}>停止本地跟踪</button>}
        {['failed', 'cancelled', 'interrupted'].includes(job.status) &&
          <button onClick={() => retryJob(job.id)}>{detail.useCurrentEngine ? '使用当前引擎重试' : '重试'}</button>}
        {job.retryOnCurrentEngine &&
          <button onClick={() => retryJob(job.id, true)}>使用当前引擎重试</button>}
      </div>
    </div>;
  }

  function backupProject() {
    setBackingUp(true);
    setBackupReport(undefined);
    setBackupProgress(undefined);
    void act(async () => {
      await checkpointPendingEdits();
      const result = await call<ProjectBackupReport | null>('backupProject', pid);
      if (result) setBackupReport(result);
    }).finally(() => setBackingUp(false));
  }

  return <>
    <nav className="project-navigation">
      {tabs.map(([id, title]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => open(id)}>{title}</button>)}
      <button className="project-backup" disabled={backingUp} onClick={backupProject}>
        {backingUp ? '正在生成备份…' : '导出项目备份'}
      </button>
    </nav>
    <div className="page">
      {tab !== 'jobs' && waitingForStorage.length > 0 && <div className="alert error" role="status">
        <p>{waitingForStorage[0].storageIssue?.message}</p>
        <button onClick={() => void act(async () => {
          for (const job of waitingForStorage) await call('resumeJob', job.id);
          await reload();
        })}>{waitingForStorage.length === 1 ? '继续任务' : `继续 ${waitingForStorage.length} 项任务`}</button>
      </div>}
      {importReport && <section className="panel" aria-label="媒体导入结果">
        <div className="row">
          <strong role="status">已导入 {importReport.imported.length} 项{importReport.failed.length > 0 && `，失败 ${importReport.failed.length} 项`}</strong>
          <button onClick={() => setImportReport(undefined)}>关闭导入结果</button>
        </div>
        {importReport.failed.length > 0 && <ul>{importReport.failed.map(({ name, reason }, index) =>
          <li key={index}>{name} — {reason}</li>)}</ul>}
      </section>}
      {recovered && Object.keys(project.editorDrafts ?? {}).some(section => Object.hasOwn(recovered, section)) &&
        <p>已恢复上次保存的编辑草稿。</p>}
      {backingUp && backupProgress && <p role="status">已复制 {backupProgress.completed} / {backupProgress.total} 个文件</p>}
      {backupReport && <div className="panel" role="status">
        <h3>项目备份已保存</h3>
        <p className="backup-path">{backupReport.directory}</p>
        {backupReport.missingAssets > 0 && <p>{backupReport.missingAssets} 项素材缺失，恢复项目后可以重新定位。</p>}
        {backupReport.missingRenders > 0 && <p>{backupReport.missingRenders} 个成片文件缺失，已保存可用的导出任务记录。</p>}
      </div>}
      {tab === 'assets' && <>
        <h1>{project.name}</h1><p>{template.description}</p>
        <div className="row">
          <button className="primary" disabled={importing} onClick={importMedia}>{importing ? '正在导入…' : '导入媒体'}</button>
          <button disabled={cleaning} onClick={openCleanup}>清理未使用素材</button>
          <button disabled={relocating} onClick={() => {
            setRelocating(true);
            void act(async () => {
              if (await call<boolean>('relocateProject', pid)) await reload();
            }).finally(() => setRelocating(false));
          }}>{relocating ? '正在检查项目目录…' : '定位已移动的项目目录'}</button>
        </div>
        {cleanup && <section className="panel" aria-label="清理未使用素材">
          <h3>清理未使用素材</h3>
          {cleanup.protectedCount > 0 && <p>{cleanup.protectedCount} 项素材正在被项目输入、剪辑、撤销记录或任务引用。</p>}
          {cleanup.assets.length === 0 && <p>当前没有可移除的素材。</p>}
          {cleanup.assets.map(asset => <label className="asset inline-label" key={asset.id}>
            <input type="checkbox" disabled={cleaning} checked={cleanupSelection.includes(asset.id)}
              onChange={event => {
                const checked = event.target.checked;
                setCleanupSelection(selected => checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id));
              }} />
            <span>{kindLabels[asset.kind]} · {asset.name}{!asset.exists && '（文件缺失）'}</span>
          </label>)}
          {cleanupReport && <div role="status">
            <p>已移除 {cleanupReport.removed} 项素材记录，{cleanupReport.trashed} 个文件已移至系统回收站。
              {cleanupReport.retained > 0 && ` ${cleanupReport.retained} 个文件保留在磁盘上。`}</p>
            {cleanupReport.pending.length > 0 && <ul>{cleanupReport.pending.map(({ name, reason }, index) =>
              <li key={index}>{name} — {reason}</li>)}</ul>}
          </div>}
          {cleanup.pendingCount > 0 && <p>{cleanup.pendingCount} 个文件等待移至系统回收站。</p>}
          <div className="row">
            {cleanup.assets.length > 0 && <>
              <button disabled={cleaning} onClick={() => setCleanupSelection(
                cleanupSelection.length === cleanup.assets.length ? [] : cleanup.assets.map(asset => asset.id)
              )}>{cleanupSelection.length === cleanup.assets.length ? '取消全选' : '全选'}</button>
              <button disabled={cleaning || !cleanupSelection.length} onClick={() => cleanMedia(cleanupSelection)}>
                移除所选素材（{cleanupSelection.length}）
              </button>
            </>}
            {cleanup.pendingCount > 0 && <button disabled={cleaning} onClick={() => cleanMedia()}>重试清理文件</button>}
            <button disabled={cleaning} onClick={() => setCleanup(undefined)}>关闭素材清理</button>
          </div>
        </section>}
        {project.assets.map(asset => <div className="asset" key={asset.id}>
          <span>{kindLabels[asset.kind]} · {asset.name}{asset.duration ? ` · ${asset.duration.toFixed(2)} 秒` : ''}</span>
          <div className="row">{asset.exists ? <>
            <button onClick={() => openAsset(asset)}>预览</button>
            <button onClick={() => void act(() => call('revealAsset', asset.id))}>定位</button>
            {hasTimeline && !asset.enhancementReviewRequired && !assetIssues[assetVersion(asset)] &&
              <button onClick={() => addToTimeline(asset)}>加入时间线</button>}
          </> : null}<button onClick={() => relinkAsset(asset.id)}>{asset.exists ? '重新定位或替换' : '重新定位'}</button></div>
        </div>)}
        {previewed && <div className="panel preview"><AssetPlayer key={assetVersion(previewed) + ':' + mediaCheckVersion}
          asset={previewed} {...assetRecovery} /></div>}
      </>}
      {tab === 'analysis' && <>
        <h1>{analysisTitle}</h1>
        <fieldset className="analysis-fields" disabled={analysisBusy} aria-label="分析输入">
          {template.fields.map(inputField)}
        </fieldset>
        <div className="row">
          <button disabled={analysisBusy || importing} onClick={importMedia}>{importing ? '正在导入…' : '导入参考素材'}</button>
          <button disabled={analysisBusy} onClick={() => void act(saveInputs, '输入已保存')}>保存输入</button>
          {hasAnalysis && <button className="primary" disabled={analysisBusy} onClick={() => runAnalysis('analyze')}>
            {analysisBusy ? '分析中…' : 'AI 分析'}
          </button>}
          {project.analysisRunning && <button onClick={() => void act(() => call('cancelAnalysis', pid))}>取消 AI 分析</button>}
        </div>
        {analysisNotice && <p role="status">{analysisNotice}</p>}
        {hasAnalysis && (project.production.analysis || recovered?.analysis || analysisResult.length > 0) && <section className="panel">
          <h2>分析结果</h2>
          {analysisStale && <p>输入已变更，请重新运行 AI 分析以更新结果。</p>}
          {referenceSourceNames && <p>本次分析使用了{referenceSourceNames}。
            {referenceSources?.transcription === 'unavailable' && '语音转写接口或模型不可用。'}
            {referenceSources?.transcription === 'empty' && '语音转写未返回可用文本。'}
          </p>}
          {transcriptionProgress && <p role="status">
            已完成 {transcriptionProgress.total - transcriptionProgress.missing.length} / {transcriptionProgress.total} 段语音转写，
            缺少第 {transcriptionProgress.missing.join('、')} 段。
          </p>}
          {analysis.referenceTranscript && <details>
            <summary>参考视频转写</summary>
            <textarea readOnly rows={5} value={analysis.referenceTranscript} aria-label="参考视频转写" />
          </details>}
          {!analysisStale && referenceSources?.transcription === 'used' && !analysis.referenceTranscript &&
            <p>旧版分析可在生成分镜建议时从原视频补回转写。也可以填写文字剧本后重新分析。</p>}
          <fieldset className="analysis-fields" disabled={analysisBusy} aria-label="编辑分析结果">
            <label>摘要<textarea rows={3} value={analysis.summary} onChange={event => setAnalysis({ ...analysis, summary: event.target.value })} /></label>
            {fashion && <div className="grid">{appearanceFields.map(([key, title]) =>
              <label key={key}>{title}<input value={analysis.productAppearance?.[key] ?? ''}
                onChange={event => setAnalysis({ ...analysis, productAppearance: {
                  ...(analysis.productAppearance ?? emptyAppearance), [key]: event.target.value,
                } })} /></label>)}</div>}
            <label>角色（每行一个）<textarea rows={3} value={analysis.characters.join('\n')}
              onChange={event => setAnalysis({ ...analysis, characters: event.target.value.split('\n') })} /></label>
            {analysis.scenes.map((scene, index) => <div key={index}>
              <div className="grid">
                <label>场次 {index + 1}<input value={scene.title}
                  onChange={event => setAnalysis({ ...analysis, scenes: analysis.scenes.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })} /></label>
                <label>说明<textarea rows={2} value={scene.description}
                  onChange={event => setAnalysis({ ...analysis, scenes: analysis.scenes.map((item, i) => i === index ? { ...item, description: event.target.value } : item) })} /></label>
              </div>
              <button onClick={() => setAnalysis({ ...analysis, scenes: analysis.scenes.filter((_, i) => i !== index) })}>
                移除场次 {index + 1}
              </button>
            </div>)}
            {analysis.sceneCuts?.length > 0 && <details><summary>参考视频镜头时间</summary>
              <ul>{analysis.sceneCuts.map(cut => <li key={cut.start}>{cut.start.toFixed(2)} 秒至 {cut.end?.toFixed(2) || '结束'} 秒</li>)}</ul>
            </details>}
            <div className="row">
              <button onClick={() => setAnalysis({ ...analysis, scenes: [...analysis.scenes, { title: '', description: '' }] })}>添加场次</button>
              <button onClick={() => void act(saveAnalysis, '分析已保存')}>保存分析修改</button>
              <button disabled={analysisStale} onClick={() => runAnalysis('suggestShots')}>从修订后的分析生成分镜建议</button>
              {transcriptionProgress && <button disabled={analysisStale} onClick={() => runAnalysis('suggestShots', true)}>
                补转写并更新分镜建议
              </button>}
              {hasStoryboard && analysisResult.length > 0 && <button onClick={() => void act(async () => {
                if (shotDraft.length && !window.confirm('使用新分析替换当前分镜草稿？已确认版本会保留，直到确认新分镜。')) return;
                await saveInputs();
                await saveAnalysis();
                await shotsCheckpoint.flush();
                const next = await call<Shot[]>('useAnalysisShots', pid);
                savedShots.current = next;
                setShotDraft(next);
                await reload();
              })}>使用 AI 分镜建议</button>}
            </div>
          </fieldset>
        </section>}
        {hasStoryboard && <>
          <h2>分镜审核</h2>
          <p>使用内置 LTX 动态工作流时，每个镜头最长 8 秒。</p>
          {hasShotReferences && <p>可以为不同镜头指定参考图。使用参考图工作流时，未单独指定的镜头使用项目画面参考图。</p>}
          {hasDialogueAudio && <p>导入音频后可按镜头选择台词配音。追加粗剪会把配音放在对应镜头下方。</p>}
          <datalist id="analysis-scenes">{analysis.scenes.map((scene, index) => <option key={index} value={scene.title} />)}</datalist>
          {shotDraft.map((shot, index) => <section className="shot" key={shot.id}>
            <label>镜头 {index + 1}<input value={shot.title} onChange={event => editShot(shot.id, { title: event.target.value })} /></label>
            <label>画面提示词<textarea rows={3} value={shot.prompt} onChange={event => editShot(shot.id, { prompt: event.target.value })} /></label>
            <div className="grid">
              <label>所属场次<input value={shot.scene || ''} list="analysis-scenes" onChange={event => editShot(shot.id, { scene: event.target.value })} /></label>
              <label>出场角色（每行一个）<textarea rows={2} value={shot.characters?.join('\n') || ''}
                onChange={event => editShot(shot.id, { characters: event.target.value.split('\n') })} /></label>
            </div>
            {hasShotReferences && <label>镜头参考图
              <select value={shot.reference_image_id ?? ''}
                onChange={event => editShot(shot.id, { reference_image_id: event.target.value || undefined })}>
                <option value="">跟随项目参考图</option>
                {shotReferenceAssets.filter(asset => asset.exists || asset.id === shot.reference_image_id).map(asset =>
                  <option value={asset.id} key={asset.id}>{asset.name}{!asset.exists && '（缺失）'}</option>)}
              </select>
            </label>}
            {hasShotReferences && shotReferenceAssets.some(asset => asset.id === shot.reference_image_id && !asset.exists) &&
              <button onClick={() => relinkAsset(shot.reference_image_id!)}>重新定位镜头参考图</button>}
            {hasDialogueAudio && <>
              <label>台词配音
                <select value={shot.dialogue_audio_id ?? ''}
                  onChange={event => editShot(shot.id, { dialogue_audio_id: event.target.value || undefined })}>
                  <option value="">选择音频</option>
                  {voiceAssets.filter(asset => asset.exists || asset.id === shot.dialogue_audio_id).map(asset =>
                    <option value={asset.id} key={asset.id}>{asset.name}{!asset.exists && '（缺失）'}</option>)}
                </select>
              </label>
              {voiceAssets.filter(asset => asset.id === shot.dialogue_audio_id).map(asset => <Fragment key={asset.id}>
                {asset.exists ? <button onClick={() => setVoicePreviewShot(voicePreviewShot === shot.id ? undefined : shot.id)}>
                  {voicePreviewShot === shot.id ? '关闭试听' : '试听配音'}
                </button> : <button onClick={() => relinkAsset(asset.id)}>重新定位配音</button>}
                {asset.exists && voicePreviewShot === shot.id &&
                  <AssetPlayer key={assetVersion(asset) + ':' + mediaCheckVersion} asset={asset} {...assetRecovery} />}
              </Fragment>)}
            </>}
            <div className="grid">
              <label>时长（秒）<input type="number" min="0.1" step="any" value={shot.duration} onChange={event => editShot(shot.id, { duration: Number(event.target.value) })} /></label>
              <label>台词<input value={shot.dialogue} onChange={event => editShot(shot.id, { dialogue: event.target.value })} /></label>
            </div>
            <div className="row">
              {[-1, 1].map(move => <button key={move} disabled={index + move < 0 || index + move >= shotDraft.length} onClick={() => {
                const ordered = [...shotDraft];
                [ordered[index], ordered[index + move]] = [ordered[index + move], ordered[index]];
                setShotDraft(ordered);
              }}>{move < 0 ? '上移' : '下移'}</button>)}
              <button onClick={() => setShotDraft(shotDraft.filter(item => item.id !== shot.id))}>移除镜头</button>
            </div>
          </section>)}
          <div className="row">
            <button onClick={() => setShotDraft([...shotDraft, { id: crypto.randomUUID(), title: '新镜头', prompt: '', dialogue: '', duration: 4 }])}>添加镜头</button>
            <button onClick={() => void act(saveShotDraft, '分镜草稿已保存')}>保存草稿</button>
            {(dirtyShots || project.production.draftShots) && <button onClick={() => void act(async () => {
              await shotsCheckpoint.flush();
              await call('saveDraft', pid, null);
              savedShots.current = project.shots;
              setShotDraft(project.shots);
              await reload();
            })}>放弃草稿</button>}
            <button className="primary" onClick={() => void act(async () => {
              await saveInputs();
              await shotsCheckpoint.flush();
              await call('approveShots', pid, shotDraft);
              savedShots.current = shotDraft;
              await reload();
            }, '分镜已确认，可以生成镜头')}>确认当前分镜</button>
          </div>
        </>}
      </>}
      {tab === 'generate' && <>
        <h1>{enhance ? '画质增强' : '镜头生成'}</h1>
        {configureEngine && <div className="row">
          <button onClick={configureEngine}>连接或安装 ComfyUI</button>
        </div>}
        {template.fields.filter(key => !hasAnalysisPage || inputFields[key].generation).map(inputField)}
        <div className="row"><button disabled={importing} onClick={importMedia}>{importing ? '正在导入…' : '导入素材'}</button>
          {preset && <><label className="inline-label">内置工作流
            <select value={preset.id} disabled={downloading} onChange={event => setPresetId(event.target.value)}>
              {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label><button onClick={() => {
            if (workflow && !window.confirm('用模板工作流替换当前编辑内容？')) return;
            setWorkflow(JSON.stringify(preset.workflow, null, 2));
            setMapping(JSON.stringify(preset.mapping, null, 2));
          }}>使用内置工作流</button>
          {hasModelMirror && <label className="inline-label">下载源
            <select value={modelSource} disabled={downloading} onChange={event => setModelSource(event.target.value)}>
              <option value="original">原始地址</option>
              <option value="modelscope">模板镜像</option>
            </select></label>}
          <button disabled={downloading} onClick={() => {
            setDownloading(true);
            setModelLog('');
            const source = hasModelMirror ? modelSource : 'original';
            void act(() => call('installPresetModels', null, pid, preset.id, source), '模板模型已下载').finally(() => setDownloading(false));
          }}>{downloading ? '下载中…' : `下载本地模板模型（${formatModelSize(preset.models)}）`}</button>
          {downloading && <button onClick={() => void act(() => call('pauseEngine'))}>暂停下载</button>}</>}
          <button onClick={() => void act(async () => {
            const value = await call<Record<string, unknown> | null>('importWorkflow');
            if (value) setWorkflow(JSON.stringify(value, null, 2));
          })}>导入工作流 JSON</button></div>
        {preset && <p>{preset.description}</p>}
        {modelLog && <pre className="log" aria-label="模型下载进度">{modelLog}</pre>}
        <label>ComfyUI API 工作流<textarea className="code-field" rows={9} value={workflow} onChange={event => setWorkflow(event.target.value)} /></label>
        <label>输入映射<textarea className="code-field" rows={3} value={mapping} onChange={event => setMapping(event.target.value)}
          placeholder={'{"prompt":{"node":"6","input":"text"}}'} /></label>
        <p>{enhance ? '将 sourceVideo 映射到视频载入节点。' : '将 prompt 映射到提示词节点，可同时映射 title、duration 和 dialogue。'}
          {template.fields.includes('productImage') && ' 将 productImage 映射到图片载入节点。'}
          {template.fields.includes('referenceImage') && ' 参考图可用 referenceImage 映射。'}</p>
        {!enhance && <section className="panel">
          <h3>选择已确认分镜</h3>
          {pendingShots ? <p>请确认或放弃当前草稿，再生成镜头。</p>
            : reviewStale && approvedShots.length > 0 ? <p>分析输入已变更，请重新确认分镜。</p>
            : !approvedShots.length ? <p>请先在{analysisTitle}页确认分镜。</p> : <>
            <button onClick={() => setSelectedShots(chosen.length === approvedShots.length ? [] : approvedShots.map(shot => shot.id))}>
              {chosen.length === approvedShots.length ? '取消全选' : '全选'}
            </button>
            {approvedShots.map(shot => <label className="inline-label" key={shot.id}>
              <input type="checkbox" checked={selectedShots.includes(shot.id)}
                onChange={event => setSelectedShots(event.target.checked ? [...selectedShots, shot.id] : selectedShots.filter(id => id !== shot.id))} />
              {shot.title} · {shot.duration} 秒
              {shot.reference_image_id && ` · 参考图：${shotReferenceAssets.find(asset => asset.id === shot.reference_image_id)?.name ?? '缺失'}`}
            </label>)}
          </>}
        </section>}
        <div className="row">
          <button onClick={() => void act(async () => {
            await saveInputs();
            await saveWorkflow();
            await reload();
          }, '工作流已保存')}>保存工作流</button>
          <button onClick={() => void act(async () => {
            const specification = readWorkflow();
            await call('preflight', specification.workflow, specification.mapping, pid);
          }, '节点与静态参数检查通过')}>预检工作流</button>
          <button className="primary" disabled={generating || !enhance && (!chosen.length || reviewStale || pendingShots)}
            onClick={() => submitGeneration(false)}>{generating ? '正在加入队列…' : enhance ? '开始增强' : `生成所选镜头（${chosen.length}）`}</button>
          {!enhance && <button disabled={generating || !chosen.length || reviewStale || pendingShots}
            onClick={() => submitGeneration(true)}>用新种子生成（{chosen.length}）</button>}
        </div>
        <h2>生成结果</h2>
        {hasTimeline && !enhance && !pendingShots && !reviewStale && approvedShots.length > 0 && generateAssets.length > 0 &&
          <button disabled={choosingVersion || appendingStoryboard} onClick={appendStoryboard}>
            {appendingStoryboard ? '正在追加粗剪…' : '按分镜顺序追加粗剪'}
          </button>}
        {storyboard?.error && !enhance && generateAssets.length > 0 && <p role="status">{storyboard.error}</p>}
        {availableResults.map(({ shotId, selectedAssetId, candidates, timelineClipIds, error }) => {
          const shot = approvedShots.find(item => item.id === shotId);
          if (!shot) return null;
          const selectedIsAvailable = candidates.some(candidate => candidate.assetId === selectedAssetId);
          const previewInGroup = previewed && candidates.some(candidate => candidate.assetId === previewed.id);
          return <section className="panel" key={shotId} aria-label={shot.title + ' 的镜头版本'}>
            <h3>{shot.title}</h3>
            {error && <p role="status">{error}</p>}
            {selectedAssetId && !selectedIsAvailable && <p role="status">已选版本不可用，请重新选择或恢复自动选择。</p>}
            {selectedAssetId && <button disabled={choosingVersion || appendingStoryboard} onClick={() => chooseVersion(shotId, null)}>恢复自动选择</button>}
            {candidates.map(({ assetId, seed }, index) => {
              const asset = assetsById.get(assetId);
              if (!asset) return null;
              const label = [assetId === selectedAssetId ? '已采用' : !selectedAssetId && index === 0 ? '自动选择' : '',
                seed === undefined ? '' : `种子 ${seed}`].filter(Boolean).join(' · ');
              const replaceCount = timelineClipIds.filter(id => timelineClips.has(id) && timelineClips.get(id)?.asset_id !== assetId).length;
              const versionDisabled = choosingVersion || appendingStoryboard || pendingShots || reviewStale;
              return renderGeneratedAsset(asset, label, <>
                {assetId !== selectedAssetId && <button disabled={versionDisabled} title="用于下一次追加粗剪"
                  onClick={() => chooseVersion(shotId, asset.id)}>采用此版本</button>}
                {replaceCount > 0 && <button disabled={versionDisabled}
                  onClick={() => replaceTimelineVersion(shotId, assetId)}>替换时间线片段（{replaceCount}）</button>}
              </>);
            })}
            {previewInGroup && <div className="preview">
              <AssetPlayer key={assetVersion(previewed) + ':' + mediaCheckVersion} asset={previewed} {...assetRecovery} />
            </div>}
          </section>;
        })}
        {!enhance && candidateAssets.size > 0 && generateAssets.some(asset => !candidateAssets.has(asset.id)) && <h3>其他生成产物</h3>}
        {generateAssets.filter(asset => !candidateAssets.has(asset.id)).map(asset => renderGeneratedAsset(asset))}
        {previewed && !candidateAssets.has(previewed.id) && (enhance && original && previewed.kind === 'video'
          ? <SideBySide key={previewed.id + ':' + mediaCheckVersion} original={original} result={previewed} {...assetRecovery} />
          : <div className="panel preview">
            {enhance && <p>生成时使用的源视频已丢失或重新定位。可查看增强结果，重新增强后可进行对比。</p>}
            <AssetPlayer key={assetVersion(previewed) + ':' + mediaCheckVersion} asset={previewed} {...assetRecovery} />
          </div>)}
      </>}
      {tab === 'timeline' && <Timeline project={project} storyboard={storyboard} reload={reload} relinkAsset={relinkAsset} act={act} mediaCheckVersion={mediaCheckVersion}
        progress={progress} editor={timelineEditor} openGeneration={() => open('generate')} />}
      {tab === 'jobs' && <><h1>任务</h1>{project.jobs.length ? project.jobs.map(renderJob) : <p>还没有生成或导出任务。</p>}</>}
    </div>
  </>;
}
