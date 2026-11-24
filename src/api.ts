export type Kind = 'video' | 'audio' | 'image';
export type TrackKind = Exclude<Kind, 'image'> | 'subtitle';
export type Format = 'landscape' | 'portrait' | 'square';
export type ExportSettings = { format: Format; resolution: number; fps?: number };

export interface ProjectEditor {
  savePendingEdits: () => Promise<void>;
  checkpointPendingEdits: () => Promise<void>;
}

export type TemplateField = 'script' | 'product' | 'sellingPoints' | 'productImage' | 'referenceImage' | 'referenceVideo' | 'sourceVideo';

export interface Template {
  id: string;
  name: string;
  version: number;
  description: string;
  fields: TemplateField[];
  stages: ('input' | 'analyze' | 'review' | 'generate' | 'edit' | 'export')[];
}

export interface Asset {
  id: string;
  name: string;
  path: string;
  kind: Kind;
  origin: string;
  exists: boolean;
  duration: number | null;
  job_id: string | null;
  revision?: number;
  enhancementReviewRequired?: boolean;
}

export interface MediaFileIssue {
  name: string;
  reason: string;
}

export interface MediaImportReport {
  imported: Asset[];
  failed: MediaFileIssue[];
}

export interface AssetCleanupPlan {
  assets: Pick<Asset, 'id' | 'name' | 'kind' | 'exists'>[];
  protectedCount: number;
  pendingCount: number;
}

export interface AssetCleanupReport {
  removed: number;
  retained: number;
  trashed: number;
  pending: MediaFileIssue[];
}

export interface Shot {
  id: string;
  title: string;
  prompt: string;
  dialogue: string;
  duration: number;
  scene?: string;
  characters?: string[];
  reference_image_id?: string;
  dialogue_audio_id?: string;
  status?: 'draft' | 'approved';
}

export interface ProductAppearance {
  color: string;
  shape: string;
  texture: string;
}

export interface Analysis {
  summary: string;
  characters: string[];
  scenes: { title: string; description: string }[];
  sceneCuts: { start: number; end: number | null }[];
  referenceSources?: {
    script: boolean;
    frames: number;
    transcription: 'used' | 'partial' | 'unavailable' | 'empty' | 'skipped';
    transcriptionProgress?: { total: number; missing: number[] };
  };
  referenceTranscript?: string;
  productAppearance?: ProductAppearance;
}

export interface Clip {
  id: string;
  track_id: string;
  asset_id: string | null;
  start: number;
  in_point: number;
  duration: number;
  volume: number;
  text: string;
  transition: 'none' | 'fade';
  linked_video_id?: string | null;
  split_offset?: number | null;
  split_duration?: number | null;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
}

export interface Job {
  id: string;
  kind: 'comfy' | 'export' | 'preview';
  status: string;
  detail: string;
  outputMissing?: boolean;
  retryOnCurrentEngine?: boolean;
  storageIssue?: { message: string; canCancel: boolean };
  localQueue?: { position: number; paused: boolean };
}

export interface Workflow {
  workflow: Record<string, unknown>;
  mapping: Record<string, { node: string; input: string }>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  dir: string;
  template_id: string;
  template_version: number;
  archived_at?: string | null;
}

export interface EditorDrafts {
  inputs?: Record<string, string>;
  analysis?: Analysis;
  shots?: Shot[];
  workflow?: { workflow: string; mapping: string };
  clip?: Clip;
}

export interface StoryboardResults {
  error?: string;
  shots: {
    shotId: string;
    selectedAssetId: string | null;
    error?: string;
    timelineClipIds: string[];
    candidates: { assetId: string; seed?: number }[];
  }[];
}

export interface Project extends ProjectSummary {
  template: Template;
  analysisRunning?: boolean;
  timelineHistory?: { undo?: string | null; redo?: string | null };
  hiddenDialogue?: { videoId: string; trackId: string }[];
  editorDrafts?: EditorDrafts;
  production: {
    inputs?: Record<string, string>;
    inputRevision?: number;
    analysis?: Analysis;
    analysisInputRevision?: number;
    analysisShots?: Shot[];
    draftShots?: Shot[] | null;
    reviewedInputRevision?: number;
    exportSettings?: ExportSettings;
    workflowDraft?: { workflow: string; mapping: string } | null;
  };
  assets: Asset[];
  shots: Shot[];
  jobs: Job[];
  tracks: Track[];
  workflow?: Workflow | null;
}

export interface JobEvent {
  id: string;
  projectId: string;
  status: string;
  progress?: number;
  step?: { node: string; value: number; max: number };
}

export interface ProjectTransferEvent {
  kind: 'backup' | 'restore';
  projectId?: string;
  completed: number;
  total: number;
}

export interface ProjectBackupReport {
  directory: string;
  missingAssets: number;
  missingRenders: number;
}

export interface EngineSetupOptions {
  dir: string;
  packageIndex: string;
  pythonMirror?: string;
  groups: string[];
  source: 'original' | 'modelscope';
}

export interface EngineSetupPlan {
  supported: boolean;
  name: string;
  backend?: string;
  driverVersion?: string;
  ref: string;
  estimatedBytes: number | null;
  availableBytes: number | null;
  installed: boolean;
  resumable: boolean;
  canRepair: boolean;
  repairing: boolean;
  groups: { id: string; name: string; downloadBytes: number }[];
}

export interface Settings {
  ai: {
    url?: string;
    model?: string;
    transcriptionModel?: string;
    transcriptionEnabled?: boolean;
    vision?: boolean;
    hasKey?: boolean;
  };
  comfy: { configured: boolean; mode: 'local' | 'external'; url: string; localUrl?: string };
  engine: { dir: string; packageIndex?: string; pythonMirror?: string };
  engineSetup: EngineSetupOptions | null;
}

declare global {
  interface Window {
    api: {
      call(name: string, ...args: unknown[]): Promise<{ ok: boolean; data: unknown; error?: string }>;
      on(name: string, callback: (data: unknown) => void): () => void;
    };
  }
}

export async function call<T = void>(name: string, ...args: unknown[]): Promise<T> {
  const response = await window.api.call(name, ...args);
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response.data as T;
}

export type Action = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
