import { useCallback, useEffect, useRef } from 'react';
import { call } from './api';
import type { Action, EditorDrafts } from './api';

export function useEditorDraft<K extends keyof EditorDrafts>(
  projectId: string, section: K, draft: EditorDrafts[K], act: Action,
) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = useCallback(() => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (draft === undefined) return;
    timer.current = window.setTimeout(() => {
      void call('saveEditorDraft', projectId, section, draft).catch(error => {
        void act(async () => { throw error; });
      });
    }, 450);
    return cancel;
  }, [projectId, section, draft, act, cancel]);

  return {
    cancel,
    async flush() {
      cancel();
      if (draft !== undefined) await call('saveEditorDraft', projectId, section, draft);
    },
  };
}
