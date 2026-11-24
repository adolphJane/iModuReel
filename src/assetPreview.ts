import type { Asset } from './api';

export type AssetFileIssue = 'missing' | 'changed' | 'unreadable';

export const assetIssueText: Record<AssetFileIssue, string> = {
  missing: '素材文件已丢失',
  changed: '素材内容已变更',
  unreadable: '素材文件无法读取',
};

export function assetVersion(asset: Asset) {
  return JSON.stringify([asset.id, asset.path, asset.revision ?? 0, asset.exists]);
}

export async function inspectAsset(id: string, signal?: AbortSignal, color = false):
  Promise<{ issue: AssetFileIssue | null; hdr: boolean }> {
  try {
    const response = await fetch(`media://asset/${id}${color ? '?color=1' : ''}`, { method: 'HEAD', signal });
    if (response.ok) return { issue: null, hdr: response.headers.get('X-iModuReel-HDR') === '1' };
    const issue = response.status === 409 ? 'changed' : response.status === 404 ? 'missing' : 'unreadable';
    return { issue, hdr: false };
  } catch {
    signal?.throwIfAborted();
    return { issue: 'unreadable', hdr: false };
  }
}

export async function inspectAssetPreview(id: string, signal?: AbortSignal): Promise<AssetFileIssue | null> {
  return (await inspectAsset(id, signal)).issue;
}
