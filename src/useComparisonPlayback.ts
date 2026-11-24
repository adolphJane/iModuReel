import { useEffect, useRef, useState } from 'react';

function commonDuration(left: HTMLVideoElement, right: HTMLVideoElement) {
  const duration = Math.min(left.duration, right.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function useComparisonPlayback() {
  const [original, originalRef] = useState<HTMLVideoElement | null>(null);
  const [result, resultRef] = useState<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const transport = useRef<{ toggle: () => void; seek: (time: number) => void }>(null);

  useEffect(() => {
    if (!original || !result) {
      setDuration(0);
      setPosition(0);
      setReady(false);
      setPlaying(false);
      return;
    }
    const follower = original;
    const master = result;
    const players = [original, result];
    const end = () => commonDuration(original, result);
    const atEnd = () => result.currentTime >= end() - 0.001;
    const readyToPlay = () => end() > 0 && players.every(player => !player.error && !player.seeking &&
      player.readyState >= (atEnd() ? HTMLMediaElement.HAVE_METADATA : HTMLMediaElement.HAVE_FUTURE_DATA));
    let requested = false;
    let request = 0;
    let animation = 0;
    let time = 0;

    function refresh() {
      setDuration(end());
      setReady(readyToPlay());
    }

    function publish(position: number) {
      time = position;
      setPosition(position);
    }

    function align(position: number) {
      if (!end()) return;
      for (const player of players) {
        if (Math.abs(player.currentTime - position) > 0.0001) player.currentTime = position;
      }
    }

    const playbackPosition = () => Math.min(master.currentTime, end());

    function pause(position = playbackPosition()) {
      requested = false;
      request++;
      cancelAnimationFrame(animation);
      for (const player of players) player.pause();
      align(position);
      publish(position);
      setPlaying(false);
      refresh();
    }

    function tick() {
      if (!requested) return;
      const position = playbackPosition();
      if (position >= end() || players.some(player => player.ended)) {
        pause(end());
        return;
      }
      if (!follower.seeking && Math.abs(follower.currentTime - position) > 0.08) follower.currentTime = position;
      if (Math.abs(time - position) >= 0.04) publish(position);
      animation = requestAnimationFrame(tick);
    }

    function toggle() {
      if (requested) { pause(); return; }
      if (!readyToPlay()) return;
      setError('');
      const position = playbackPosition();
      const start = atEnd() ? 0 : position;
      align(start);
      publish(start);
      requested = true;
      setPlaying(true);
      const current = ++request;
      void Promise.all(players.map(player => player.play())).then(() => {
        if (request === current) animation = requestAnimationFrame(tick);
      }).catch(() => {
        if (request !== current) return;
        pause();
        setError('无法同时播放，请在两段视频加载后重试。');
      });
    }

    function seek(time: number) {
      if (!Number.isFinite(time) || !end()) return;
      setError('');
      pause(Math.min(end(), Math.max(0, time)));
    }

    const ended = () => pause(end());
    const interrupted = () => {
      if (requested) pause();
      else refresh();
    };
    const buffering = () => {
      if (requested && players.some(player => !player.seeking && player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) {
        pause();
        setError('视频正在缓冲，加载后可继续对比。');
      } else refresh();
    };
    const paused = () => {
      if (requested && players.some(player => player.paused)) pause();
    };
    const mediaEvents = ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'seeking', 'seeked'];
    for (const player of players) {
      for (const event of mediaEvents) player.addEventListener(event, refresh);
      for (const event of ['error', 'emptied']) player.addEventListener(event, interrupted);
      player.addEventListener('ended', ended);
      player.addEventListener('waiting', buffering);
      player.addEventListener('pause', paused);
    }
    transport.current = { toggle, seek };
    refresh();
    return () => {
      request++;
      cancelAnimationFrame(animation);
      for (const player of players) {
        for (const event of mediaEvents) player.removeEventListener(event, refresh);
        for (const event of ['error', 'emptied']) player.removeEventListener(event, interrupted);
        player.removeEventListener('ended', ended);
        player.removeEventListener('waiting', buffering);
        player.removeEventListener('pause', paused);
        player.pause();
      }
      transport.current = null;
    };
  }, [original, result]);

  return {
    originalRef, resultRef, duration, position, ready, playing, error,
    toggle: () => transport.current?.toggle(),
    seek: (time: number) => transport.current?.seek(time),
  };
}
