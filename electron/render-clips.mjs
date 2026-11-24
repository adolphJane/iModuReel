export function renderClips(tracks) {
  return JSON.stringify(tracks.flatMap(track => track.clips.map(clip => [
    track.kind, clip.asset_id, clip.start, clip.in_point, clip.duration, clip.volume, clip.text, clip.transition,
    clip.split_offset ?? null, clip.split_duration ?? null,
  ])));
}

export function defaultRenderSettings(templateId) {
  return templateId === 'enhance' ? { format: 'landscape', resolution: 1080, fps: 30 }
    : { format: 'portrait', resolution: 720, fps: 30 };
}
