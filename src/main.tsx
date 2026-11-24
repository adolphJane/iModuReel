import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { call } from './api';
import type { Action, Project, ProjectEditor, ProjectSummary, ProjectTransferEvent, Settings, Template } from './api';
import { ProjectView } from './ProjectView';
import { EngineSetup } from './EngineSetup';
import './style.css';

function Preferences({ act, onComfyChange }: { act: Action; onComfyChange: (comfy: Settings['comfy']) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [key, setKey] = useState('');
  useEffect(() => {
    void act(async () => setSettings(await call<Settings>('settings')));
  }, [act]);
  if (!settings) return <div className="page">正在读取设置…</div>;
  const ai = (patch: Partial<Settings['ai']>) => setSettings(previous => previous && ({
    ...previous, ai: { ...previous.ai, ...patch },
  }));
  return <div className="page">
    <h1>设置与引擎</h1>
    <EngineSetup settings={settings} act={act} onChange={comfy => {
      setSettings(previous => previous && ({ ...previous, comfy }));
      onComfyChange(comfy);
    }} />
    <h2>AI 分析服务</h2>
    <div className="grid">
      <label>OpenAI 兼容接口地址<input value={settings.ai.url || ''} placeholder="https://服务地址/v1" onChange={event => ai({ url: event.target.value })} /></label>
      <label>模型<input value={settings.ai.model || ''} onChange={event => ai({ model: event.target.value })} /></label>
      <label>API Key<input type="password" autoComplete="off" value={key} placeholder={settings.ai.hasKey ? '密钥已保存' : '输入密钥'} onChange={event => setKey(event.target.value)} /></label>
      <label>语音转写模型<input value={settings.ai.transcriptionModel || ''} placeholder="whisper-1" disabled={settings.ai.transcriptionEnabled === false} onChange={event => ai({ transcriptionModel: event.target.value })} /></label>
    </div>
    {settings.ai.hasKey && <p>更换接口地址时，请填写该服务的 API Key。</p>}
    <label className="inline-label"><input type="checkbox" checked={settings.ai.vision ?? false} onChange={event => ai({ vision: event.target.checked })} />
      向支持视觉的模型发送商品图和参考视频抽帧</label>
    <label className="inline-label"><input type="checkbox" checked={settings.ai.transcriptionEnabled !== false} onChange={event => ai({ transcriptionEnabled: event.target.checked })} />
      转写参考视频语音</label>
    <div className="row">
      <button className="primary" onClick={() => void act(async () => {
        ai(await call<Settings['ai']>('saveAI', { ...settings.ai, apiKey: key }));
        setKey('');
      }, 'AI 设置已保存')}>保存 AI 设置</button>
      {settings.ai.hasKey && <button onClick={() => void act(async () => {
        ai(await call<Settings['ai']>('saveAI', { ...settings.ai, clearKey: true }));
        setKey('');
      }, '密钥已清除')}>清除密钥</button>}
    </div>
  </div>;
}

function ProjectManager({ projects, act, open, refresh }: {
  projects: ProjectSummary[];
  act: Action;
  open: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [saving, setSaving] = useState(false);
  const changeProject = (action: 'renameProject' | 'archiveProject' | 'unarchiveProject', id: string, name?: string) => {
    setSaving(true);
    void act(async () => {
      await call(action, id, name);
      await refresh();
      setRenaming(undefined);
    }, { renameProject: '项目名称已更新', archiveProject: '项目已归档', unarchiveProject: '项目已恢复到项目列表' }[action])
      .finally(() => setSaving(false));
  };
  return <div className="page project-manager">
    <h1>项目管理</h1>
    <h2>进行中的项目</h2>
    {projects.filter(project => !project.archived_at).map(project => <section className="panel project-entry" key={project.id}>
      <div className="project-entry-info">
        <h3>{project.name}</h3>
        <p>{project.dir}</p>
      </div>
      {renaming?.id === project.id ?
        <form className="row" onSubmit={event => {
          event.preventDefault();
          changeProject('renameProject', project.id, renaming.name);
        }}>
          <input autoFocus aria-label="新项目名称" required value={renaming.name} disabled={saving}
            onChange={event => setRenaming({ id: project.id, name: event.target.value })} />
          <button className="primary" disabled={saving || !renaming.name.trim() || renaming.name.trim() === project.name}>保存名称</button>
          <button type="button" disabled={saving} onClick={() => setRenaming(undefined)}>取消</button>
        </form>
        : <div className="row">
          <button disabled={saving} onClick={() => void act(() => open(project.id))}>打开</button>
          <button disabled={saving} onClick={() => setRenaming({ id: project.id, name: project.name })}>重命名</button>
          <button disabled={saving} onClick={() => changeProject('archiveProject', project.id)}>归档</button>
        </div>}
    </section>)}
    {!projects.some(project => !project.archived_at) && <p>暂无进行中的项目</p>}
    <h2>已归档项目</h2>
    {projects.filter(project => project.archived_at).map(project => <section className="panel project-entry" key={project.id}>
      <div className="project-entry-info"><h3>{project.name}</h3><p>{project.dir}</p></div>
      <button disabled={saving} onClick={() => changeProject('unarchiveProject', project.id)}>恢复到项目列表</button>
    </section>)}
    {!projects.some(project => project.archived_at) && <p>暂无归档项目</p>}
  </div>;
}

function App() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [active, setActive] = useState<Project>();
  const [page, setPage] = useState<'home' | 'manage' | 'settings' | 'project'>('home');
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [engineConfigured, setEngineConfigured] = useState<boolean>();
  const [projectName, setProjectName] = useState('');
  const [directory, setDirectory] = useState('');
  const [templateId, setTemplateId] = useState('drama');
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<ProjectTransferEvent>();
  const [notification, setNotification] = useState<{ text: string; error?: boolean }>();
  const request = useRef(0);
  const editor = useRef<ProjectEditor>(null);
  const main = useRef<HTMLElement>(null);
  const settingsOpen = page === 'settings';
  const refreshProjects = async () => setProjects(await call<ProjectSummary[]>('projects', true));

  const act: Action = useCallback(async (fn, success) => {
    setNotification(undefined);
    try {
      await fn();
      if (success) setNotification({ text: success });
    } catch (error) {
      setNotification({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  }, []);
  const saveProjectOnLeave = useCallback(async () => {
    const current = editor.current;
    if (!current) return;
    await current.checkpointPendingEdits();
    // Unfinished edits can fail validation. Their recovery drafts are already saved.
    await current.savePendingEdits().catch(() => {});
  }, []);
  useEffect(() => {
    const unsubscribe = window.api.on('saveBeforeClose', () => {
      void act(async () => {
        try {
          await saveProjectOnLeave();
        } catch (error) {
          await call('finishClose', false);
          throw error;
        }
        await call('finishClose', true);
      });
    });
    void act(() => call('allowCloseRequests'));
    return unsubscribe;
  }, [act, saveProjectOnLeave]);
  useEffect(() => { void act(async () => {
    const [available, recent, settings] = await Promise.all([
      call<Template[]>('templates'), call<ProjectSummary[]>('projects', true), call<Settings>('settings'),
    ]);
    setTemplates(available);
    setProjects(recent);
    setEngineConfigured(settings.comfy.configured);
  }); }, [act]);
  useEffect(() => window.api.on('projectTransfer', data => {
    const progress = data as ProjectTransferEvent;
    if (progress.kind === 'restore') setRestoreProgress(progress);
  }), []);
  const open = async (id: string) => {
    const selection = ++request.current;
    await saveProjectOnLeave();
    const project = await call<Project>('project', id);
    if (selection === request.current) {
      setActive(project);
      setPage('project');
    }
  };
  const leaveProject = (target: 'home' | 'manage') => void act(async () => {
    const selection = ++request.current;
    await saveProjectOnLeave();
    if (selection === request.current) {
      setActive(undefined);
      setPage(target);
    }
  });

  useEffect(() => { if (page !== 'project') main.current?.scrollTo(0, 0); }, [page]);
  const showSettings = () => {
    request.current++;
    setSettingsVisited(true);
    setPage('settings');
  };
  return <div className="app">
    <aside>
      <div className="brand">◈ iModuReel</div>
      <button onClick={() => leaveProject('home')}>项目首页</button>
      <button className={page === 'manage' ? 'active' : ''} onClick={() => leaveProject('manage')}>项目管理</button>
      <div className="sidebar-projects">
        {projects.filter(project => !project.archived_at).map(project =>
          <button key={project.id} className={page === 'project' && active?.id === project.id ? 'active' : ''}
            title={project.name} onClick={() => void act(() => open(project.id))}>{project.name}</button>)}
      </div>
      <div className="spacer" />
      <button className={settingsOpen ? 'active' : ''} onClick={showSettings}>设置与引擎</button>
    </aside>
    <main ref={main}>
      <header><strong>{settingsOpen ? '设置' : page === 'manage' ? '项目管理' : active?.name || '项目工作台'}</strong><span>iModuReel</span></header>
      {notification && <div role={notification.error ? 'alert' : 'status'} className={'alert ' + (notification.error ? 'error' : '')}>
        {notification.text}<button aria-label="关闭提示" onClick={() => setNotification(undefined)}>×</button>
      </div>}
      {settingsVisited && <div hidden={!settingsOpen}><Preferences act={act} onComfyChange={comfy => setEngineConfigured(comfy.configured)} /></div>}
      {active && <div hidden={settingsOpen}>
        <ProjectView key={active.id} initial={active} act={act} editor={editor}
          configureEngine={engineConfigured === false ? showSettings : undefined} />
      </div>}
      {page === 'manage' && <ProjectManager projects={projects} act={act} open={open} refresh={refreshProjects} />}
      {page === 'home' && <div className="page">
        <h1>创建视频项目</h1>
        <div className="row"><button disabled={restoring} onClick={() => {
          setRestoring(true);
          setRestoreProgress(undefined);
          void act(async () => {
            const result = await call<{ project: ProjectSummary; missingAssets: number; missingRenders: number } | null>('restoreProject');
            if (!result) return;
            await refreshProjects();
            await open(result.project.id);
            const messages = ['项目已从备份恢复。'];
            if (result.missingAssets) messages.push(`${result.missingAssets} 项素材需要重新定位。`);
            if (result.missingRenders) messages.push(`${result.missingRenders} 个成片文件不可用，已保留对应导出任务。`);
            setNotification({ text: messages.join('') });
          }).finally(() => setRestoring(false));
        }}>{restoring ? '正在恢复项目…' : '从备份恢复项目'}</button></div>
        {restoring && restoreProgress && <p role="status">已复制 {restoreProgress.completed} / {restoreProgress.total} 个文件</p>}
        {engineConfigured === false && <section className="panel engine-onboarding">
          <h3>配置生成引擎</h3>
          <button onClick={showSettings}>连接或安装 ComfyUI</button>
        </section>}
        <div className="cards">{templates.map(item => <button key={item.id} className={'card ' + (item.id === templateId ? 'selected' : '')}
          onClick={() => setTemplateId(item.id)}><h3>{item.name}</h3><p>{item.description}</p></button>)}</div>
        <form className="panel" onSubmit={event => {
          event.preventDefault();
          void act(async () => {
            const project = await call<ProjectSummary>('createProject', projectName, directory, templateId);
            await refreshProjects();
            await open(project.id);
            setProjectName('');
            setDirectory('');
          }, '项目已创建');
        }}>
          <label>项目名称<input required value={projectName} onChange={event => setProjectName(event.target.value)} /></label>
          <label>项目目录</label>
          <div className="row"><input readOnly value={directory} aria-label="项目目录" />
            <button type="button" onClick={() => void act(async () => {
              const dir = await call<string | null>('chooseDir');
              if (dir) setDirectory(dir);
            })}>选择目录</button></div>
          <button disabled={!directory || !projectName.trim()} className="primary">创建项目</button>
        </form>
      </div>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
