import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode, Ref } from 'react';
import { call } from './api';
import type { Action, Clip, ExportSettings, Format, JobEvent, Project, ProjectEditor, StoryboardResults, Track, TrackKind } from './api';
import { useEditorDraft } from './useEditorDraft';
import { assetIssueText, assetVersion, inspectAsset } from './assetPreview';
import type { AssetFileIssue } from './assetPreview';
import { defaultRenderSettings, renderClips } from '../electron/render-clips.mjs';

const trackNames = { video: '视频', audio: '音频', subtitle: '字幕' };
const clipFields = {
  start: ['起点（秒）', 0, 86400],
  in_point: ['素材入点（秒）', 0, 86400],
  duration: ['时长（秒）', 0.04, 86400],
  volume: ['音量', 0, 4],
} as const;
const tickIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

function timeLabel(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function ClipEditor({ draft, track, linkedMedia, hiddenDialogue, versionAction, onChange, onSave, onDiscard, onDelete, onDetach }: {
  draft: Clip;
  track: Track;
  linkedMedia: string;
  hiddenDialogue: boolean;
  versionAction?: ReactNode;
  onChange: (clip: Clip) => void;
  onSave: () => void;
  onDiscard?: () => void;
  onDelete: () => void;
  onDetach: () => void;
}) {
  const fields = Object.entries(clipFields) as [keyof typeof clipFields, (typeof clipFields)[keyof typeof clipFields]][];
  const linkLabel = track.kind === 'audio' ? '配音' : '字幕';
  return <form className="panel clip-editor" onSubmit={event => {
    event.preventDefault();
    onSave();
  }}>
    <div className="grid">
      {fields.filter(([key]) => track.kind !== 'subtitle' || key === 'start' || key === 'duration').map(([key, [label, min, max]]) =>
        <label key={key}>{label}
          <input type="number" min={min} max={max} step="any" required value={draft[key]}
            readOnly={Boolean(draft.linked_video_id) && (key === 'start' || key === 'duration')}
            onChange={event => onChange({ ...draft, [key]: Number(event.target.value) })} />
        </label>)}
      {track.kind === 'video' && <label>转场
        <select value={draft.transition} onChange={event => onChange({ ...draft, transition: event.target.value as Clip['transition'] })}>
          <option value="none">直接切换</option><option value="fade">淡入淡出</option>
        </select>
      </label>}
    </div>
    {draft.linked_video_id && <p>{linkLabel}随关联镜头移动和裁切。</p>}
    {hiddenDialogue && <p>关联配音在当前裁切范围外。调整入点或时长后可恢复。</p>}
    {track.kind === 'subtitle' && <label>字幕<textarea rows={2} value={draft.text} onChange={event => onChange({ ...draft, text: event.target.value })} /></label>}
    {versionAction}
    <div className="row"><button className="primary">保存片段</button>
      {onDiscard && <button type="button" onClick={onDiscard}>放弃修改</button>}
      {draft.linked_video_id && <button type="button" onClick={onDetach}>解除{linkLabel}关联</button>}
      <button type="button" onClick={onDelete}>{linkedMedia ? '删除镜头和关联' + linkedMedia : '删除片段'}</button></div>
  </form>;
}

export function Timeline({ project, storyboard, reload, relinkAsset, act, progress, editor, openGeneration, mediaCheckVersion }: {
  project: Project;
  storyboard?: StoryboardResults;
  reload: () => Promise<void>;
  relinkAsset: (assetId: string) => void;
  act: Action;
  progress: Record<string, JobEvent>;
  editor: Ref<ProjectEditor>;
  openGeneration: () => void;
  mediaCheckVersion: number;
}) {
  const [settings, setSettings] = useState<ExportSettings>(project.production.exportSettings ?? defaultRenderSettings(project.template_id));
  const { format, resolution, fps = 30 } = settings;
  const recoveredClip = project.editorDrafts?.clip;
  const [selected, setSelected] = useState(recoveredClip?.id);
  const [draft, setDraft] = useState(recoveredClip);
  const [replacement, setReplacement] = useState<{ clipId: string; assetId: string }>();
  const clipCheckpoint = useEditorDraft(project.id, 'clip', draft, act);
  const [assetSelections, setAssetSelections] = useState<Record<string, string>>({});
  const [renamingTrack, setRenamingTrack] = useState<{ id: string; name: string }>();
  const [trackBusy, setTrackBusy] = useState(false);
  const [requestingPreview, setRequestingPreview] = useState(false);
  const [scale, setScale] = useState(62);
  const [playhead, setPlayhead] = useState(0);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const dragging = useRef<{ id: string; trackId: string; offset: number }>(null);
  const [dropHint, setDropHint] = useState<{ id: string; side: 'before' | 'after' }>();
  const usedAssets = useMemo(() => new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.asset_id))), [project.tracks]);
  const sources = useMemo(() => project.assets.filter(asset => usedAssets.has(asset.id)), [project.assets, usedAssets]);
  const preview = project.jobs.find(job => job.kind === 'preview');
  const previewBusy = preview?.status === 'queued' || preview?.status === 'rendering';
  const rendered = project.jobs.find(job => job.kind === 'preview' && job.status === 'done');
  const checkColor = Boolean(rendered && !JSON.parse(rendered.detail).colorPipelineVersion);
  const sourceKey = JSON.stringify(sources.map(asset => [asset.id, assetVersion(asset), checkColor && asset.kind !== 'audio']));
  const [fileChecks, setFileChecks] = useState<{
    sourceKey: string; checkVersion: number; issues: Record<string, AssetFileIssue>; hasHdr: boolean;
  }>();
  useEffect(() => {
    const versions: [id: string, version: string, checkColor: boolean][] = JSON.parse(sourceKey);
    let pending: AbortController | undefined;
    const verify = () => {
      pending?.abort();
      const controller = pending = new AbortController();
      void (async () => {
        const issues: Record<string, AssetFileIssue> = {};
        let hasHdr = false;
        for (const [id, , checkColor] of versions) {
          const { issue, hdr } = await inspectAsset(id, controller.signal, checkColor);
          if (issue) issues[id] = issue;
          hasHdr ||= hdr;
        }
        if (!controller.signal.aborted) setFileChecks({ sourceKey, checkVersion: mediaCheckVersion, issues, hasHdr });
      })().catch(() => {});
    };
    verify();
    window.addEventListener('focus', verify);
    return () => {
      pending?.abort();
      window.removeEventListener('focus', verify);
    };
  }, [sourceKey, mediaCheckVersion]);
  const checked = fileChecks?.sourceKey === sourceKey && fileChecks.checkVersion === mediaCheckVersion;
  const issues = checked ? fileChecks.issues : {};
  const missingAssets = sources.filter(asset => !asset.exists || issues[asset.id] === 'missing');
  const changedAssets = sources.filter(asset => asset.exists && issues[asset.id] && issues[asset.id] !== 'missing');
  const blockedAssets = new Set([...missingAssets, ...changedAssets].map(asset => asset.id));
  const pendingReview = sources.filter(asset => asset.enhancementReviewRequired && !blockedAssets.has(asset.id));
  const canRender = !blockedAssets.size && !pendingReview.length;
  // FFmpeg composites higher positions last. Display those tracks at the top.
  const visibleTracks = [...project.tracks].reverse();
  const duration = Math.max(0, ...project.tracks.flatMap(track => track.clips.map(clip => clip.start + clip.duration)));
  const timelineSeconds = Math.max(10, duration);
  const pixels = Math.min(12000, Math.max(520, (timelineSeconds + 2) * scale));
  const unit = pixels / (timelineSeconds + 2);
  const tick = tickIntervals.find(interval => interval * unit >= 65) ?? 7200;
  const ticks = Array.from({ length: Math.floor((timelineSeconds + 2) / tick) + 1 }, (_, index) => index * tick);
  const [unplayablePreview, setUnplayablePreview] = useState<string>();
  const previewMissing = rendered && (rendered.outputMissing || unplayablePreview === rendered.id);
  const fresh = useMemo(() => {
    if (!rendered || checkColor && checked && fileChecks.hasHdr) return false;
    const { format: renderedFormat, fps: renderedFps = 30, snapshot, videoTrimVersion, frameTimingVersion, captionLayoutVersion, audioSampleTimingVersion }:
      { format?: Format; fps?: number; snapshot?: Pick<Project, 'assets' | 'tracks'>;
        videoTrimVersion?: number; frameTimingVersion?: number; captionLayoutVersion?: number; audioSampleTimingVersion?: number } = JSON.parse(rendered.detail);
    if (!snapshot || renderedFormat !== format || renderedFps !== fps || renderClips(snapshot.tracks) !== renderClips(project.tracks)) return false;
    if (!captionLayoutVersion && snapshot.tracks.some(track => track.kind === 'subtitle' && track.clips.some(clip => clip.text.trim()))) return false;
    const renderedAssets = new Map(snapshot.assets.map(asset => [asset.id, asset]));
    if (!audioSampleTimingVersion && snapshot.tracks.some(track => track.kind !== 'subtitle' && track.clips.some(clip =>
      clip.asset_id && renderedAssets.get(clip.asset_id)?.kind !== 'image' &&
      Math.abs(clip.start * 1000 - Math.round(clip.start * 1000)) > 0.000001))) return false;
    if (!videoTrimVersion && snapshot.tracks.some(track => track.kind === 'video' && track.clips.some(clip =>
      clip.in_point > 0 && clip.asset_id && renderedAssets.get(clip.asset_id)?.kind === 'video'))) return false;
    const offFrame = (time: number) => Math.abs(time * fps - Math.round(time * fps)) > 0.000001;
    if (!frameTimingVersion && snapshot.tracks.some(track => track.kind !== 'audio' && track.clips.some(clip =>
      offFrame(clip.start) || offFrame(clip.start + clip.duration)))) return false;
    return project.assets.filter(asset => usedAssets.has(asset.id)).every(asset => {
      const original = renderedAssets.get(asset.id);
      return asset.exists && !asset.enhancementReviewRequired && original !== undefined &&
        (original.revision ?? 0) === (asset.revision ?? 0);
    });
  }, [rendered, checkColor, checked, fileChecks, format, fps, project.tracks, project.assets, usedAssets]);
  const editingTrack = project.tracks.find(track => track.clips.some(clip => clip.id === selected));
  const editingClip = editingTrack?.clips.find(clip => clip.id === selected);
  const shotVersions = editingClip && storyboard?.shots.find(shot => shot.timelineClipIds.includes(editingClip.id));
  const currentClipKind = editingClip && project.assets.find(asset => asset.id === editingClip.asset_id)?.kind;
  const versions = (shotVersions?.candidates ?? []).flatMap(({ assetId, seed }) => {
    const asset = project.assets.find(asset => asset.id === assetId);
    return asset?.exists && asset.kind === currentClipKind && assetId !== editingClip?.asset_id ? [{ asset, seed }] : [];
  });
  const replacementId = replacement && replacement.clipId === editingClip?.id &&
    versions.some(({ asset }) => asset.id === replacement.assetId) ? replacement.assetId : '';
  const hiddenDialogue = project.hiddenDialogue ?? [];
  const editingHiddenDialogue = hiddenDialogue.some(link => link.videoId === editingClip?.id);
  const linkedMedia = editingTrack?.kind === 'video' ? (['subtitle', 'audio'] as const).filter(kind => kind === 'audio' && editingHiddenDialogue ||
    project.tracks.some(track => track.kind === kind && track.clips.some(clip => clip.linked_video_id === editingClip?.id)))
    .map(kind => kind === 'audio' ? '配音' : '字幕').join('及') : '';
  const clipToSplit = draft?.id === editingClip?.id ? draft : editingClip;
  const splitPoint = Math.round(playhead * fps) / fps;
  const canSplit = Boolean(clipToSplit && !clipToSplit.linked_video_id && splitPoint - clipToSplit.start >= 0.04 - 1e-9 &&
    clipToSplit.start + clipToSplit.duration - splitPoint >= 0.04 - 1e-9);
  const canUndo = Boolean(draft || project.timelineHistory?.undo);
  const canRedo = !draft && Boolean(project.timelineHistory?.redo);

  async function savePendingEdits() {
    if (!draft) return;
    await clipCheckpoint.flush();
    const { id, start, in_point, duration, volume, text, transition } = draft;
    await call('updateClip', id, { start, in_point, duration, volume, text, transition });
    await reload();
    setDraft(current => current === draft ? undefined : current);
  }

  useImperativeHandle(editor, () => ({ savePendingEdits, checkpointPendingEdits: clipCheckpoint.flush }));

  function changeTrack(task: () => Promise<void>) {
    setTrackBusy(true);
    void act(async () => {
      await task();
      await reload();
    }).finally(() => setTrackBusy(false));
  }

  function stepHistory(direction: 'undo' | 'redo') {
    if (trackBusy || !(direction === 'undo' ? canUndo : canRedo)) return;
    changeTrack(async () => {
      await savePendingEdits();
      await call('stepTimeline', project.id, direction);
      setSelected(undefined);
      setRenamingTrack(undefined);
      setAssetSelections({});
    });
  }

  function splitSelectedClip() {
    if (trackBusy || !canSplit || !clipToSplit) return;
    changeTrack(async () => {
      await savePendingEdits();
      const right = await call<Clip>('splitClip', clipToSplit.id, splitPoint, fps);
      setSelected(right.id);
      seek(right.start);
    });
  }

  function replaceClipVersion() {
    if (!shotVersions || !replacementId || !editingClip || trackBusy) return;
    changeTrack(async () => {
      await savePendingEdits();
      await call('replaceShotVersion', project.id, shotVersions.shotId, replacementId, editingClip.id);
      setReplacement(undefined);
    });
  }

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || event.defaultPrevented ||
          event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      const key = event.key.toLowerCase();
      const redo = key === 'y' || key === 'z' && event.shiftKey;
      if (key !== 'z' && !redo) return;
      event.preventDefault();
      stepHistory(redo ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  });

  function removeTrack(track: Track) {
    const removed = new Set(track.clips.map(clip => clip.id));
    const links = (['subtitle', 'audio'] as const).map(kind => {
      const clips = project.tracks.filter(other => other.kind === kind).flatMap(other => other.clips)
        .filter(clip => clip.linked_video_id && removed.has(clip.linked_video_id));
      return { label: kind === 'audio' ? '配音' : '字幕', clips, count: clips.length +
        (kind === 'audio' ? hiddenDialogue.filter(link => removed.has(link.videoId)).length : 0) };
    });
    const linked = links.filter(group => group.count).map(group => `${group.count} 个关联${group.label}`).join('和 ');
    const detail = linked ? '及其他轨道上的 ' + linked : '';
    const total = track.clips.length + hiddenDialogue.filter(link => link.trackId === track.id).length;
    if (total && !window.confirm(`删除「${track.name}」轨道及其 ${total} 个片段${detail}？`)) return;
    for (const group of links) for (const clip of group.clips) removed.add(clip.id);
    changeTrack(async () => {
      if (draft && removed.has(draft.id)) await clipCheckpoint.flush();
      else await savePendingEdits();
      await call('deleteTrack', project.id, track.id);
      setDraft(previous => previous && removed.has(previous.id) ? undefined : previous);
      setSelected(previous => previous && removed.has(previous) ? undefined : previous);
      setRenamingTrack(previous => previous?.id === track.id ? undefined : previous);
      setAssetSelections(previous => {
        const next = { ...previous };
        delete next[track.id];
        return next;
      });
    });
  }

  function seek(time: number) {
    const next = Math.max(0, Math.min(time, duration));
    setPlayhead(next);
    const video = previewVideo.current;
    if (video && Number.isFinite(video.duration)) video.currentTime = Math.min(next, video.duration);
  }

  function updateSettings(patch: Partial<ExportSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    void act(async () => {
      await call('saveExportSettings', project.id, next.format, next.resolution, next.fps ?? 30);
      await reload();
    });
  }

  function insertion(event: DragEvent<HTMLDivElement>, track: Track) {
    const source = dragging.current;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-clip-id]') : null;
    const id = target?.dataset.clipId;
    if (!source || source.trackId !== track.id || event.shiftKey || !target || !id || id === source.id) return undefined;
    const bounds = target.getBoundingClientRect();
    const side = event.clientX < bounds.left + bounds.width / 2 ? 'before' as const : 'after' as const;
    return { id, side };
  }

  function dragOver(event: DragEvent<HTMLDivElement>, track: Track) {
    if (!event.dataTransfer.types.includes('application/imodureel-clip')) return;
    event.preventDefault();
    const next = insertion(event, track);
    setDropHint(previous => previous?.id === next?.id && previous?.side === next?.side ? previous : next);
  }

  function clearDrag() {
    dragging.current = null;
    setDropHint(undefined);
  }

  function drop(event: DragEvent<HTMLDivElement>, track: Track) {
    event.preventDefault();
    const clipId = event.dataTransfer.getData('application/imodureel-clip');
    if (!clipId) return;
    const target = insertion(event, track);
    const offset = dragging.current?.offset ?? 0;
    const time = (event.clientX - event.currentTarget.getBoundingClientRect().left - offset) / unit;
    const start = Math.max(0, Math.round(time * fps) / fps);
    clearDrag();
    void act(async () => {
      await savePendingEdits();
      if (target) await call('reorderClip', clipId, target.id, target.side);
      else await call('updateClip', clipId, { start, track_id: track.id });
      setSelected(clipId);
      await reload();
    });
  }
  return <>
    <h1>多轨剪辑</h1>
    {missingAssets.length > 0 && <section className="panel" aria-label="缺失的时间线素材">
      <h3>缺失的时间线素材</h3>
      {missingAssets.map(asset => <div key={asset.id} className="asset">
        <span>{asset.name}</span>
        <button aria-label={'重新定位 ' + asset.name} onClick={() => relinkAsset(asset.id)}>重新定位</button>
      </div>)}
    </section>}
    {changedAssets.length > 0 && <section className="panel" aria-label="已变更或无法读取的时间线素材">
      <h3>时间线素材需要重新定位</h3>
      {changedAssets.map(asset => <div key={asset.id} className="asset">
        <span>{asset.name} · {assetIssueText[issues[asset.id]]}</span>
        <button aria-label={'重新定位 ' + asset.name} onClick={() => relinkAsset(asset.id)}>重新定位或替换</button>
      </div>)}
    </section>}
    {pendingReview.length > 0 && <div className="panel" role="status">
      <p>请在生成页确认时间线上的增强结果 {pendingReview.map(asset => asset.name).join('、')}，再预览或导出。</p>
      <button onClick={openGeneration}>前往确认增强结果</button>
    </div>}
    <div className="row">
      {(Object.keys(trackNames) as TrackKind[]).map(kind => <button key={kind} disabled={trackBusy} onClick={() => changeTrack(async () => {
        const names = new Set(project.tracks.map(track => track.name));
        let index = 1;
        while (names.has(`${trackNames[kind]} ${index}`)) index++;
        await call('addTrack', project.id, kind, `${trackNames[kind]} ${index}`);
      })}>＋{trackNames[kind]}轨</button>)}
      <button disabled={trackBusy || !canSplit} onClick={splitSelectedClip}>在播放头拆分</button>
      <button disabled={trackBusy || !canUndo} title={draft ? '撤销片段修改' : project.timelineHistory?.undo ?? undefined}
        onClick={() => stepHistory('undo')}>撤销</button>
      <button disabled={trackBusy || !canRedo} title={project.timelineHistory?.redo ?? undefined} onClick={() => stepHistory('redo')}>重做</button>
      <label className="inline-label">画幅 <select value={format} onChange={event => updateSettings({ format: event.target.value as Format })}>
        <option value="portrait">9:16 竖屏</option><option value="landscape">16:9 横屏</option><option value="square">1:1 方形</option>
      </select></label>
      <label className="inline-label">导出分辨率 <select value={resolution} onChange={event => updateSettings({ resolution: Number(event.target.value) })}>
        <option value={720}>720p</option><option value={1080}>1080p</option><option value={2160}>4K</option>
      </select></label>
      <label className="inline-label">帧率 <select value={fps} onChange={event => updateSettings({ fps: Number(event.target.value) })}>
        {[24, 25, 30, 50, 60].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
      </select></label>
      <button disabled={trackBusy || !canRender || requestingPreview || previewBusy} onClick={() => {
        setRequestingPreview(true);
        void act(async () => {
          await savePendingEdits();
          await call('export', project.id, format, true, resolution, fps);
          await reload();
        }).finally(() => setRequestingPreview(false));
      }}>生成合成预览</button>
      {previewBusy && preview.storageIssue?.canCancel !== false &&
        <button onClick={() => void act(async () => {
          await call('cancelJob', preview.id);
          await reload();
        })}>取消合成预览</button>}
      <button className="primary" disabled={trackBusy || !canRender} onClick={() => void act(async () => {
        await savePendingEdits();
        await call('export', project.id, format, false, resolution, fps);
        await reload();
      }, '已加入导出队列')}>导出 MP4</button>
    </div>
    {fresh && rendered && !previewMissing && !blockedAssets.size && (checked || !sources.length) && <div className="panel preview">
      <video key={rendered.id} ref={previewVideo} controls src={`media://render/${rendered.id}`}
        onLoadedMetadata={event => { event.currentTarget.currentTime = Math.min(playhead, event.currentTarget.duration); }}
        onTimeUpdate={event => setPlayhead(Math.min(event.currentTarget.currentTime, duration))}
        onError={() => setUnplayablePreview(rendered.id)} />
    </div>}
    {previewMissing ? <p role="status">预览文件不可用，可重新生成合成预览。</p>
      : rendered && !fresh && <p>当前预览需要重新生成。</p>}
    {fresh && !previewMissing && !blockedAssets.size && sources.length > 0 && !checked && <p role="status">正在检查时间线素材…</p>}
    {preview?.storageIssue ? <p>预览等待磁盘空间</p> : <>
      {preview?.status === 'queued' && <p>预览等待渲染</p>}
      {preview?.status === 'rendering' && <p>正在合成预览 {Math.round((progress[preview.id]?.progress || 0) * 100)}%</p>}
    </>}
    {preview?.status === 'failed' && <div className="alert error">{JSON.parse(preview.detail).error}</div>}
    {preview?.status === 'interrupted' && !fresh && <p role="status">{JSON.parse(preview.detail).error}</p>}
    <label className="inline-label">缩放 <input type="range" min="20" max="120" value={scale} onChange={event => setScale(Number(event.target.value))} /></label>
    {project.tracks.length > 0 && <p>拖到同轨片段的左侧或右侧可插入排序。拖到空白处或按住 Shift 可自由摆放。</p>}
    {project.tracks.filter(track => track.kind === 'video').length > 1 && <p>上方视频轨覆盖下方视频轨。字幕叠在画面上。</p>}
    {project.tracks.length > 0 && <div className="timeline-board">
      <div className="timeline-ruler" style={{ width: pixels }} role="slider" tabIndex={0} aria-label="预览播放位置"
        aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.min(playhead, duration)}
        aria-valuetext={`${playhead.toFixed(2)} 秒`}
        onPointerDown={event => seek((event.clientX - event.currentTarget.getBoundingClientRect().left) / unit)}
        onKeyDown={event => {
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            seek(event.key === 'Home' ? 0 : duration);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            seek(playhead + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 1 / fps));
          }
        }}>
        {ticks.map(time => <span className="timeline-tick" key={time} style={{ left: time * unit }}>{timeLabel(time)}</span>)}
        <span className="timeline-playhead" style={{ left: Math.min(playhead, duration) * unit }} />
      </div>
      {visibleTracks.map((track, index) => {
      const available = project.assets.filter(asset => asset.exists && !asset.enhancementReviewRequired && !blockedAssets.has(asset.id) &&
        (track.kind === 'video' ? asset.kind === 'video' || asset.kind === 'image' : asset.kind === track.kind));
      return <section className="track timeline-track" key={track.id} style={{ width: pixels }}>
        <div className="row track-header">
          <h3>{track.name}</h3>
          {track.kind !== 'subtitle' && <select aria-label={track.name + '素材'} value={assetSelections[track.id] || ''}
            onChange={event => setAssetSelections({ ...assetSelections, [track.id]: event.target.value })}>
            <option value="">选择素材</option>{available.map(asset => <option value={asset.id} key={asset.id}>{asset.name}</option>)}
          </select>}
          <button disabled={trackBusy || track.kind !== 'subtitle' && !assetSelections[track.id]} onClick={() => void act(async () => {
            await savePendingEdits();
            const clip = await call<Clip>('addClip', track.id, { asset_id: assetSelections[track.id] || null, text: track.kind === 'subtitle' ? '新字幕' : '' });
            setSelected(clip.id);
            await reload();
          })}>添加片段</button>
          {renamingTrack?.id === track.id ? <form className="row track-rename" onSubmit={event => {
            event.preventDefault();
            changeTrack(async () => {
              await call('renameTrack', project.id, track.id, renamingTrack.name);
              setRenamingTrack(undefined);
            });
          }}>
            <input autoFocus aria-label="新轨道名称" required value={renamingTrack.name} disabled={trackBusy}
              onChange={event => setRenamingTrack({ id: track.id, name: event.target.value })} />
            <button className="primary" disabled={trackBusy || !renamingTrack.name.trim() || renamingTrack.name.trim() === track.name}>保存名称</button>
            <button type="button" disabled={trackBusy} onClick={() => setRenamingTrack(undefined)}>取消</button>
          </form> : <>
            <button disabled={trackBusy} aria-label={`重命名轨道 ${track.name}`}
              onClick={() => setRenamingTrack({ id: track.id, name: track.name })}>重命名</button>
            <button disabled={trackBusy || index === 0} aria-label={`上移轨道 ${track.name}`}
              onClick={() => changeTrack(() => call('moveTrack', project.id, track.id, 1))}>上移</button>
            <button disabled={trackBusy || index === visibleTracks.length - 1} aria-label={`下移轨道 ${track.name}`}
              onClick={() => changeTrack(() => call('moveTrack', project.id, track.id, -1))}>下移</button>
            <button disabled={trackBusy} aria-label={`删除轨道 ${track.name}`} onClick={() => removeTrack(track)}>删除轨道</button>
          </>}
        </div>
        <div className="timeline-lane" style={{ backgroundSize: `${unit * tick}px 100%` }}
          onDragOver={event => dragOver(event, track)}
          onDragLeave={event => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropHint(undefined);
          }}
          onDrop={event => drop(event, track)}>
          {track.clips.map(clip => <button key={clip.id} data-clip-id={clip.id} draggable={!clip.linked_video_id}
            className={`timeline-clip ${selected === clip.id ? 'active' : ''}${dropHint?.id === clip.id ? ' drop-' + dropHint.side : ''}`}
            title={`${clip.start.toFixed(2)}s · ${clip.duration.toFixed(2)}s`}
            style={{ left: clip.start * unit, width: Math.max(22, clip.duration * unit) }}
            onDragStart={event => {
              if (clip.linked_video_id) { event.preventDefault(); return; }
              dragging.current = { id: clip.id, trackId: track.id, offset: event.clientX - event.currentTarget.getBoundingClientRect().left };
              event.dataTransfer.setData('application/imodureel-clip', clip.id);
            }}
            onDragEnd={clearDrag}
            onClick={() => void act(async () => {
              if (selected === clip.id) return;
              await savePendingEdits();
              setSelected(clip.id);
              seek(clip.start);
            })}>
            {clip.text || project.assets.find(asset => asset.id === clip.asset_id)?.name || '缺失素材'}
          </button>)}
          <span className="timeline-playhead" style={{ left: Math.min(playhead, duration) * unit }} />
        </div>
      </section>;
      })}
    </div>}
    {editingTrack && editingClip && <ClipEditor draft={draft?.id === editingClip.id ? draft : editingClip} track={editingTrack}
      versionAction={versions.length > 0 && <div className="row">
        <label className="inline-label">镜头版本
          <select value={replacementId} disabled={trackBusy} onChange={event => setReplacement({ clipId: editingClip.id, assetId: event.target.value })}>
            <option value="">选择要换用的版本</option>
            {versions.map(({ asset, seed }) => <option key={asset.id} value={asset.id}>
              {asset.name}{seed !== undefined && ` · 种子 ${seed}`}
            </option>)}
          </select>
        </label>
        <button type="button" disabled={trackBusy || !replacementId} onClick={replaceClipVersion}>替换此片段</button>
      </div>}
      linkedMedia={linkedMedia} hiddenDialogue={editingHiddenDialogue} onChange={setDraft} onSave={() => void act(savePendingEdits)}
      onDiscard={draft ? () => void act(async () => {
        clipCheckpoint.cancel();
        await call('saveEditorDraft', project.id, 'clip', null);
        setDraft(current => current === draft ? undefined : current);
        await reload();
      }) : undefined}
      onDetach={() => void act(async () => {
        await savePendingEdits();
        await call('updateClip', editingClip.id, { detachLink: true });
        await reload();
      })}
      onDelete={() => void act(async () => {
        await clipCheckpoint.flush();
        await call('deleteClip', editingClip.id);
        setDraft(undefined);
        setSelected(undefined);
        await reload();
      })} />}
  </>;
}
