import { useEffect, useState } from 'react';
import { call } from './api';
import type { Action, EngineSetupOptions, EngineSetupPlan, Settings } from './api';

function size(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

export function EngineSetup({ settings, act, onChange }: {
  settings: Settings;
  act: Action;
  onChange: (comfy: Settings['comfy']) => void;
}) {
  const [mode, setMode] = useState(settings.comfy.mode);
  const [address, setAddress] = useState(settings.comfy.url);
  const [options, setOptions] = useState<EngineSetupOptions>(settings.engineSetup ?? {
    dir: settings.engine.dir, packageIndex: settings.engine.packageIndex || '', pythonMirror: settings.engine.pythonMirror || '',
    groups: ['still'], source: 'original',
  });
  const [plan, setPlan] = useState<EngineSetupPlan>();
  const [planError, setPlanError] = useState('');
  const [planVersion, refreshPlan] = useState(0);
  const [busy, setBusy] = useState<'setup' | 'connect' | 'manifest'>();
  const [log, setLog] = useState('');

  useEffect(() => {
    let current = true;
    setPlan(undefined);
    setPlanError('');
    if (mode === 'local') void call<EngineSetupPlan>('engineSetupPlan', options.dir).then(value => {
      if (current) setPlan(value);
    }).catch(error => { if (current) setPlanError(error.message); });
    return () => { current = false; };
  }, [mode, options.dir, planVersion]);

  useEffect(() => window.api.on('engineLog', text => setLog(previous => (previous + String(text)).slice(-8000))), []);

  const modelBytes = plan?.groups.filter(group => options.groups.includes(group.id))
    .reduce((total, group) => total + group.downloadBytes, 0) ?? 0;
  const runtimeBytes = plan?.installed || plan?.resumable ? 0 : plan?.estimatedBytes ?? 0;
  const total = runtimeBytes + modelBytes;
  const insufficient = Boolean(plan && plan.availableBytes !== null && plan.availableBytes < total);
  const update = (changes: Partial<EngineSetupOptions>) => setOptions(previous => ({ ...previous, ...changes }));
  const installLabel = plan?.repairing ? '继续修复并连接' : plan?.resumable ? '继续安装并连接' : '安装并连接';

  function setup(groups = options.groups, repairRuntime = false) {
    setBusy('setup');
    setLog('');
    void act(async () => {
      onChange(await call<Settings['comfy']>('setupLocalEngine', { ...options, groups, repairRuntime }));
    }, '本地 ComfyUI 已连接').finally(() => {
      setBusy(undefined);
      refreshPlan(version => version + 1);
    });
  }

  return <section aria-labelledby="engine-setup-heading">
    <h2 id="engine-setup-heading">生成引擎</h2>
    {settings.comfy.configured && <p>{settings.comfy.mode === 'external' ? `当前使用外部实例 · ${settings.comfy.url}`
      : settings.comfy.localUrl ? `本地引擎已运行 · ${settings.comfy.localUrl}` : '本地引擎将在需要时启动'}</p>}
    <div role="group" aria-label="连接方式" className="row">
      <button disabled={Boolean(busy)} aria-pressed={mode === 'external'} className={mode === 'external' ? 'selected' : ''}
        onClick={() => setMode('external')}>连接已有 ComfyUI</button>
      <button disabled={Boolean(busy)} aria-pressed={mode === 'local'} className={mode === 'local' ? 'selected' : ''}
        onClick={() => setMode('local')}>本地安装</button>
    </div>
    {mode === 'external' ? <form className="panel" onSubmit={event => {
      event.preventDefault();
      setBusy('connect');
      void act(async () => {
        onChange(await call<Settings['comfy']>('connectExternalComfy', address));
      }, '已连接外部 ComfyUI').finally(() => setBusy(undefined));
    }}>
      <label>ComfyUI 服务地址<input type="url" required value={address} disabled={Boolean(busy)}
        onChange={event => setAddress(event.target.value)} /></label>
      <button className="primary" disabled={Boolean(busy)}>{busy ? '正在测试连接…' : '测试并连接'}</button>
      <details>
        <summary>Apple MPS 动态镜头兼容</summary>
        <p>如果外部 Apple MPS 实例生成的动态镜头全黑，导出节点并放入该实例的 custom_nodes 目录，然后重启 ComfyUI。</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => void act(async () => {
          const file = await call<string | null>('exportMpsVideoNodes');
          if (file) setLog(`已导出兼容节点 · ${file}`);
        })}>导出 MPS 兼容节点</button>
      </details>
    </form> : <div className="panel">
      {planError && <p role="alert">{planError}</p>}
      {!plan && !planError && <p role="status">正在检查本机硬件和安装目录…</p>}
      {plan && <p>{plan.name}{plan.supported && ` · ${plan.backend} · ComfyUI ${plan.ref}`}
        {plan.supported && plan.driverVersion && ` · 驱动 ${plan.driverVersion}`}
      </p>}
      {plan?.supported && <>
        <label htmlFor="engine-directory">安装目录</label>
        <div className="row"><input id="engine-directory" readOnly value={options.dir} />
          <button disabled={Boolean(busy)} onClick={() => void act(async () => {
            const directory = await call<string | null>('chooseDir');
            if (directory) update({ dir: directory });
          })}>选择安装目录</button></div>
        <h3>安装所需模板模型</h3>
        {plan.groups.map(group => <label className="inline-label" key={group.id}>
          <input type="checkbox" checked={options.groups.includes(group.id)} disabled={Boolean(busy)}
            onChange={event => update({ groups: event.target.checked
              ? [...options.groups, group.id] : options.groups.filter(id => id !== group.id) })} />
          {group.name} · {group.downloadBytes > 0 ? size(group.downloadBytes) : '待校验'}
        </label>)}
        <p role="status">{plan.repairing ? '运行环境待继续修复' : plan.installed ? '已安装运行环境'
          : plan.resumable ? '将复用现有运行环境和下载文件，剩余空间按实际安装检查'
            : `运行环境约 ${size(runtimeBytes)}`}
          {modelBytes > 0 && ` · 模型 ${size(modelBytes)}`}
          {runtimeBytes > 0 && modelBytes > 0 && ` · 合计约 ${size(total)}`}
          {plan.availableBytes !== null && ` · 目录可用 ${size(plan.availableBytes)}`}
        </p>
        {insufficient && <p role="alert">所选目录空间不足，请更换目录或减少所选模型。</p>}
        <details>
          <summary>下载设置</summary>
          <label>模型下载源<select value={options.source} disabled={Boolean(busy)}
            onChange={event => update({ source: event.target.value as EngineSetupOptions['source'] })}>
            <option value="original">原始地址</option>
            <option value="modelscope">优先使用模板镜像</option>
          </select></label>
          <label>Python 包镜像（可选）<input value={options.packageIndex} placeholder="默认使用 PyPI" disabled={Boolean(busy)}
            onChange={event => update({ packageIndex: event.target.value })} /></label>
          <label>Python 运行时镜像（可选）<input type="url" value={options.pythonMirror ?? ''} placeholder="默认使用 Astral 发布源"
            disabled={Boolean(busy)} onChange={event => update({ pythonMirror: event.target.value })} /></label>
          <button disabled={!plan.installed || Boolean(busy)} onClick={() => {
            setBusy('manifest');
            void act(async () => {
              const result = await call<{ count: number } | null>('installModelManifest', options.dir);
              if (result) setLog(previous => previous + `已校验 ${result.count} 项模型\n`);
            }).finally(() => { setBusy(undefined); refreshPlan(version => version + 1); });
          }}>从清单安装模型</button>
        </details>
        <div className="row">
          <button className="primary" disabled={Boolean(busy) || insufficient} onClick={() => setup()}>
            {busy === 'setup' ? '正在安装或启动…' : installLabel}
          </button>
          {plan.installed && options.groups.length > 0 && <button disabled={Boolean(busy)} onClick={() => setup([])}>直接启动已有引擎</button>}
          {plan.canRepair && <button disabled={Boolean(busy) || Boolean(settings.comfy.localUrl)}
            onClick={() => setup(options.groups, true)}>{plan.repairing ? '仅继续修复运行环境' : '修复运行环境'}</button>}
          {(busy === 'setup' || busy === 'manifest') && <button onClick={() => void act(() => call('pauseEngine'))}>暂停下载</button>}
          {settings.comfy.localUrl && <button disabled={Boolean(busy)} onClick={() => void act(async () => {
            onChange(await call<Settings['comfy']>('stopEngine'));
          }, '本地引擎已停止')}>停止引擎</button>}
        </div>
      </>}
      {plan && !plan.supported && <button onClick={() => setMode('external')}>改用已有 ComfyUI</button>}
      {log && <pre className="log" aria-label="引擎安装进度">{log}</pre>}
    </div>}
  </section>;
}
