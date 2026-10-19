import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Layers3, LayoutGrid, Settings2, Activity, Plus, RefreshCw, ArrowUpRight, ArrowRightLeft, Search, Check, X, ChevronRight, ShieldCheck, Download, ExternalLink, MoreHorizontal, LogIn, FolderOpen, RotateCcw, AlertCircle, Command, Zap, CircleHelp, Trash2, Pencil, Building2, UserRound, LoaderCircle } from 'lucide-react';
import type { Account, Bucket, LimitWindow, Snapshot, Settings, Result } from './types';
import WorkflowPanel from './WorkflowPanel';

const team = (a: Account) => ['business', 'team', 'enterprise', 'edu'].includes(a.plan.toLowerCase());
const planName = (plan: string) => ({ plus: 'Plus', pro: 'Pro', business: 'Business', team: 'Team', enterprise: 'Enterprise', free: 'Free', edu: 'Edu', unknown: '待验证' }[plan.toLowerCase()] || plan);
const time = (v: number) => new Date(v).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(value: number | null, now: number) { if (!value) return '尚未同步'; const s = Math.max(0, Math.floor((now - value) / 1000)); return s < 60 ? `${s} 秒前同步` : `${Math.floor(s / 60)} 分钟前同步`; }
function duration(minutes: number | null, key: string) { if (!minutes) return key === 'primary' ? '主要额度' : '次要额度'; if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`; if (minutes % 60 === 0) return `${minutes / 60} 小时额度`; return `${minutes} 分钟额度`; }
function resetLabel(w: LimitWindow, now: number) { if (!w.resetsAt) return '重置时间未知'; const min = Math.ceil((w.resetsAt * 1000 - now) / 60000); if (min <= 0) return '已到重置时间 · 待同步'; if (min < 60) return `${min} 分钟后重置`; if (min < 1440) return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟后重置`; return `${Math.floor(min / 1440)} 天 ${Math.floor(min % 1440 / 60)} 小时后重置`; }

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState('accounts');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'add' | 'help' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    if (!window.deck) return;
    const result = await window.deck.snapshot();
    if (result.ok && result.value) { setSnapshot(result.value); setNow(Date.now()); } else setNotice({ message: result.error || '无法读取账号。', error: true });
  }, []);
  useEffect(() => {
    load();
    const visibleLoad = () => { if (!document.hidden) { setNow(Date.now()); load(); } };
    const off = window.deck?.onChanged(() => { if (!document.hidden) load(); });
    // Rendering has no second-by-second timer. Hidden windows perform no periodic IPC reads.
    const timer = setInterval(visibleLoad, 60000);
    document.addEventListener('visibilitychange', visibleLoad);
    window.addEventListener('focus', visibleLoad);
    return () => { off?.(); clearInterval(timer); document.removeEventListener('visibilitychange', visibleLoad); window.removeEventListener('focus', visibleLoad); };
  }, [load]);
  async function run(action: () => Promise<Result>, message?: string) {
    setBusy(true); setNotice(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error || '操作失败。');
      const m = (result.value as { message?: string } | undefined)?.message || message;
      if (m) setNotice({ message: m, error: false });
      await load(); return result;
    } catch (e) { setNotice({ message: e instanceof Error ? e.message : String(e), error: true }); return null; }
    finally { setBusy(false); }
  }
  if (!window.deck) return <div className="standalone"><Layers3 size={40}/><h1>Codex Account Deck</h1><p>这是独立桌面客户端。请使用 npm run dev 或安装 Windows 安装包运行。</p></div>;
  if (!snapshot) return <div className="standalone"><LoaderCircle className="spin"/><p>{notice?.message || '正在打开本地账号保险库…'}</p></div>;
  const api = window.deck;
  const accounts = snapshot.accounts;
  const current = accounts.find(a => a.isTarget);
  const filtered = accounts.filter(a => (filter === 'all' || (filter === 'team' ? team(a) : !team(a))) && `${a.label} ${a.email} ${a.accountId} ${a.plan}`.toLowerCase().includes(search.toLowerCase()));
  const valid = accounts.filter(a => a.syncedAt && !a.error && now - a.syncedAt < snapshot.settings.pollSeconds * 2000);
  const available = accounts.filter(a => !a.error && a.syncedAt && now - a.syncedAt < snapshot.settings.pollSeconds * 2000 && a.limits.some(b => b.windows.some(w => w.remaining !== null)) && a.limits.every(b => b.windows.every(w => w.remaining === null || w.remaining > 0)));
  const blocked = busy || snapshot.syncing;
  return <div className={`app-shell ${snapshot.settings.lowResource ? 'low-resource' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Layers3 size={23}/></div><div>Account Deck<small>FOR CODEX</small></div></div>
      <div className="workspace-label">工作空间 <span>LOCAL</span></div>
      <nav>
        <button className={page === 'accounts' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('accounts')}><LayoutGrid size={18}/>账号总览 <span>{accounts.length}</span></button>
        <button className={page === 'activity' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('activity')}><Activity size={18}/>操作记录</button>
        <button className={page === 'workflow' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('workflow')}><Zap size={18}/>自动工作流</button>
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('settings')}><Settings2 size={18}/>客户端设置</button>
      </nav>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={19}/><div>凭据仅保存在本机<small>由 Windows 系统加密保护</small></div></div><button className="nav-item" onClick={() => setModal('help')}><CircleHelp size={18}/>使用说明 <ArrowUpRight size={15}/></button><div className="version"><span className="dot green"/>桌面客户端 <span>v0.2.0</span></div></div>
    </aside>
    <main>
      <header className="topbar"><div><span className="breadcrumb">工作空间</span><ChevronRight size={13}/><span>{page === 'accounts' ? '账号总览' : page === 'settings' ? '客户端设置' : page === 'workflow' ? '自动工作流' : '操作记录'}</span></div><span className="local-pill"><span className="dot green"/>本地运行</span></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow">YOUR ACCOUNTS, IN ONE PLACE</div><h1>{page === 'accounts' ? '账号总览' : page === 'settings' ? '客户端设置' : page === 'workflow' ? '自动工作流' : '操作记录'}<span className="heading-dot">.</span></h1><p>{page === 'accounts' ? '管理你的 ChatGPT 账号，随时掌握 Codex 可用额度。' : page === 'settings' ? '连接本机 Codex，按你的节奏同步。' : page === 'workflow' ? '额度耗尽时自动接力，在同一项目和会话中继续任务。' : '查看本机账号管理与切换的操作结果。'}</p></div>
          {page === 'accounts' && <div className="heading-actions"><button className="button" disabled={blocked} onClick={() => run(() => api.sync(), '额度已同步，失败账号请查看卡片提示。')}><RefreshCw size={16} className={snapshot.syncing ? 'spin' : ''}/>{snapshot.syncing ? '正在同步' : '同步全部'}</button><button className="button primary" onClick={() => setModal('add')} disabled={busy}><Plus size={17}/>添加账号</button></div>}
        </div>
        {notice && <div role="alert" className={`notice ${notice.error ? 'error' : 'success'}`}><AlertCircle size={17}/><span>{notice.message}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16}/></button></div>}
        {snapshot.targetError && <div className="notice error"><AlertCircle size={17}/><span>读取目标登录状态失败：{snapshot.targetError}</span></div>}
        {snapshot.login && <div className="login-banner"><LoaderCircle className="spin" size={18}/><div><strong>等待浏览器完成登录</strong><p>{snapshot.login.code ? <>在验证页面输入 <code>{snapshot.login.code}</code></> : '可在浏览器中选择其他账号或商业工作空间，完成后自动加入。'}</p></div><button className="button" onClick={() => run(() => api.openLogin())}>打开登录页<ExternalLink size={14}/></button><button className="icon-button" aria-label="取消登录" onClick={() => run(() => api.cancelLogin())}><X size={18}/></button></div>}
        {page === 'accounts' && <>
          <div className="stats-grid"><Stat title="已添加账号" number={accounts.length.toString().padStart(2, '0')} icon={<Layers3 size={18}/>} detail={`${accounts.filter(a => !team(a)).length} 个个人 · ${accounts.filter(team).length} 个商业`} />
            <Stat title="额度可用账号" number={available.length.toString().padStart(2, '0')} icon={<Zap size={18}/>} detail="已同步且各已知窗口均有余额" accent/>
            <Stat title="最近同步成功" number={valid.length.toString().padStart(2, '0')} icon={<RefreshCw size={18}/>} detail={snapshot.settings.autoSync ? `每 ${snapshot.settings.pollSeconds} 秒自动同步` : '自动同步已暂停'} />
          </div>
          <section className="current-banner"><div className="current-icon"><Command size={24}/></div><div className="current-text"><div className="section-caption"><span className="dot green"/>目标本地登录状态</div><strong>{current?.label || snapshot.target?.email || (snapshot.target ? '当前账号尚未加入' : '未检测到登录')}</strong><span>{current ? `${current.email || current.accountId} · ${planName(current.plan)}` : '导入当前登录后，即可在这里统一管理'}</span></div><div className="current-right"><span className="outline-tag">CODEX DESKTOP</span><button className="text-button" disabled={blocked} onClick={() => run(() => api.importCurrent(), '当前登录已加入。点击同步查询额度。')}>导入当前登录 <ArrowUpRight size={15}/></button></div></section>
          <section className="account-section"><div className="list-toolbar"><div className="tabs">{[['all', '全部账号'], ['personal', '个人'], ['team', '商业']].map(([key, label]) => <button className={filter === key ? 'selected' : ''} key={key} onClick={() => setFilter(key)}>{label}{key === 'all' && <span>{accounts.length}</span>}</button>)}</div><label className="search-box"><Search size={16}/><input aria-label="搜索账号" placeholder="搜索名称、邮箱或工作空间…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌕</kbd></label></div>
            <div className="section-subtitle"><span>{filtered.length} 个账号</span><span><span className={`dot ${snapshot.settings.autoSync ? 'green' : 'gray'}`}/>{snapshot.settings.autoSync ? '自动同步已开启' : '自动同步已暂停'} · 显示剩余额度</span></div>
            <div className="accounts-grid">{filtered.map(a => <AccountCard key={a.id} account={a} now={now} stale={Boolean(a.error || !a.syncedAt || now - a.syncedAt > snapshot.settings.pollSeconds * 2000)} disabled={blocked} onSync={() => run(() => api.sync(a.id))} onSwitch={restart => run(() => api.switch(a.id, restart))} onRename={label => run(() => api.rename(a.id, label))} onRemove={() => run(() => api.remove(a.id))}/>)}
              {!accounts.length ? <div className="empty-state"><div className="empty-art"><Layers3 size={32}/><span><Plus size={14}/></span></div><h2>把你的第一个账号放进来</h2><p>通过官方浏览器登录添加个人或商业账号，<br/>也可以直接导入本机 Codex 的当前登录。</p><div><button className="button primary" onClick={() => setModal('add')}><Plus size={16}/>添加账号</button><button className="text-button" disabled={blocked} onClick={() => run(() => api.importCurrent(), '当前登录已加入。')}>导入当前登录<ArrowUpRight size={15}/></button></div><span className="empty-footnote"><ShieldCheck size={13}/>无需输入或保存 ChatGPT 密码</span></div>
              : filtered.length === 0 ? <div className="no-results"><Search size={25}/><h3>没有找到匹配的账号</h3><button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button></div>
              : <button className="add-card" onClick={() => setModal('add')}><span><Plus size={23}/></span><strong>添加一个账号</strong><small>让工作在账号之间流动</small></button>}
            </div>
          </section>
          <div className="bottom-note"><ShieldCheck size={15}/><span>额度来自 Codex 官方服务；不同工作空间、额度窗口分别展示。</span><button onClick={() => setModal('help')}>了解工作方式<ArrowUpRight size={13}/></button></div>
        </>}
        {page === 'settings' && <SettingsPanel initial={snapshot.settings} busy={blocked} canRestore={snapshot.canRestore} save={patch => run(() => api.settings(patch), '设置已保存。')} pick={kind => api.pick(kind)} restore={() => run(() => api.restore(), '已恢复切换前的本地登录状态。')} detect={() => run(() => api.redetect(), '已重新检测官方安装，后续更新会自动跟随。')}/>}
        {page === 'workflow' && <WorkflowPanel snapshot={snapshot} api={api} busy={busy} run={run}/>}
        {page === 'activity' && <section className="panel activity-panel"><div className="panel-heading"><Activity size={19}/><h2>最近操作</h2><span>仅存于本机</span></div>{snapshot.events.length ? snapshot.events.map(e => <div className="event-row" key={e.id}><div className={`event-dot ${e.type === 'error' ? 'red' : ''}`}/><span>{e.message}</span><time>{new Date(e.at).toLocaleDateString('zh-CN')} {time(e.at)}</time></div>) : <div className="no-results"><Activity size={26}/><p>添加账号后，操作结果会显示在这里。</p></div>}</section>}
        <footer><span>ACCOUNT DECK <span className="footer-slash">/</span> 为专注而切换</span><span>独立本地工具 · 非 OpenAI 官方产品</span></footer>
      </div>
    </main>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-label={modal === 'add' ? '添加账号' : '使用说明'} onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭对话框" onClick={() => setModal(null)}><X size={20}/></button>{modal === 'add' ? <AddPanel disabled={busy || Boolean(snapshot.login)} start={async (label, method) => { const r = await run(() => api.startLogin(label, method)); if (r) setModal(null); }} importFile={async () => { const r = await run(() => api.importFile()); if (r) setModal(null); }} importCurrent={async () => { const r = await run(() => api.importCurrent(), '当前登录已加入。'); if (r) setModal(null); }}/> : <><div className="modal-symbol"><CircleHelp size={25}/></div><h2>关于账号切换</h2><div className="help-copy"><p>每个账号通过 Codex 官方登录授权。个人、Business、Enterprise 等身份由服务返回的套餐信息识别；同一用户的不同工作空间可以分别保存。</p><p>添加商业身份时，在官方登录页面选择对应工作空间。组织仍须允许使用 Codex。</p><p>额度每 30–3600 秒刷新，可手动立即同步；显示的是 Codex 额度，不包含 ChatGPT 网页全部模型的消息额度。失败和过期数据会标记，不把未知额度当成 100%。</p><p>“切换并重启”会请求关闭所选桌面程序；若仍驻留后台，4 秒后结束已验证的目标进程树。确认退出后保存旧登录、替换目标 CODEX_HOME 的 auth.json 并启动。请先完成正在执行的任务。退出失败时不写入凭据。</p><p>当前登录标记仅代表本地缓存匹配。桌面客户端须支持该缓存；若使用独立登录存储或系统 keyring，不能保证切换成功。切换后请在客户端核对账号。</p><p>凭据通过 Electron safeStorage 加密保存，Windows 使用 DPAPI。官方登录、非当前账号同步期间，隔离目录会临时存放 auth.json，结束后清理。API Key 账号不支持订阅额度查询。</p></div></>}</section></div>}
    </div>;
}

function Stat({ title, number, icon, detail, accent = false }: { title: string; number: string; icon: ReactNode; detail: string; accent?: boolean }) { return <div className={`stat-card ${accent ? 'accent' : ''}`}><div className="stat-top"><span>{title}</span><span className="stat-icon">{icon}</span></div><strong>{number}</strong><div className="stat-detail">{accent && <span className="dot green"/>}{detail}</div></div>; }
function Quota({ bucket, now }: { bucket: Bucket; now: number }) { return <div className="bucket">{<div className="bucket-name">{bucket.name === 'codex' ? 'Codex' : bucket.name}</div>}{bucket.windows.length ? bucket.windows.map(w => <div key={w.key} className="quota"><div className="quota-label"><span>{duration(w.minutes, w.key)}</span><strong className={w.remaining !== null && w.remaining <= 20 ? 'low' : ''}>{w.remaining === null ? '未知' : <>{Math.round(w.remaining)}<small>%</small></>}</strong></div><div className="quota-track"><div className={w.remaining !== null && w.remaining <= 20 ? 'quota-fill low' : 'quota-fill'} style={{ width: `${w.remaining ?? 0}%` }}/></div><div className="reset-time">{resetLabel(w, now)}</div></div>) : <p className="muted">服务未返回额度窗口</p>}{bucket.credits && <div className="credit-note">工作空间点数：{bucket.credits.unlimited ? '不限量' : bucket.credits.balance ?? '未知'}</div>}</div>; }
function AccountCard({ account: a, now, stale, disabled, onSync, onSwitch, onRename, onRemove }: { account: Account; now: number; stale: boolean; disabled: boolean; onSync(): void; onSwitch(restart: boolean): void; onRename(label: string): void; onRemove(): void }) {
  const [menu, setMenu] = useState(false); const [editing, setEditing] = useState(false); const [label, setLabel] = useState(a.label); const [removing, setRemoving] = useState(false);
  return <article className={`account-card ${a.isTarget ? 'target-card' : ''}`}>
    <div className="card-header"><div className={`avatar ${team(a) ? 'business' : ''}`}>{team(a) ? <Building2 size={23}/> : <UserRound size={23}/>}</div><div className="account-title"><h3 title={a.label}>{a.label}</h3><span title={a.email || a.accountId}>{a.email || a.accountId}</span></div><div className="card-menu"><button className="icon-button" aria-label={`${a.label}的更多操作`} onClick={() => setMenu(!menu)}><MoreHorizontal size={20}/></button>{menu && <div className="dropdown"><button onClick={() => { setEditing(true); setMenu(false); }}><Pencil size={14}/>编辑备注</button><button disabled={disabled} onClick={() => { onSync(); setMenu(false); }}><RefreshCw size={14}/>同步额度</button><button disabled={disabled} onClick={() => { onSwitch(false); setMenu(false); }}><ArrowRightLeft size={14}/>仅切换（客户端须退出）</button><button disabled={disabled} onClick={() => { setRemoving(true); setMenu(false); }}><Trash2 size={14}/>移除账号</button></div>}</div></div>
    <div className="card-meta"><span className={`plan-tag ${team(a) ? 'business' : ''}`}>{team(a) && <Building2 size={11}/>}ChatGPT {planName(a.plan)}</span>{a.isTarget && <span className="current-tag"><Check size={12}/>本地当前</span>}</div>
    {editing && <form className="inline-editor" onSubmit={e => { e.preventDefault(); onRename(label); setEditing(false); }}><input aria-label="账号备注" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} autoFocus/><button disabled={disabled} className="icon-button" aria-label="保存备注"><Check size={17}/></button><button type="button" className="icon-button" aria-label="取消编辑" onClick={() => setEditing(false)}><X size={17}/></button></form>}
    <div className="workspace-id" title={a.accountId}>工作空间 <code>{a.accountId.length > 22 ? `${a.accountId.slice(0, 10)}…${a.accountId.slice(-7)}` : a.accountId}</code></div>
    <div className="card-quotas">{a.limits.length ? a.limits.map(b => <Quota key={b.id} bucket={b} now={now}/>) : <div className="unknown-quota"><div><span>Codex 可用额度</span><strong>—</strong></div><div className="quota-track"/><p>等待首次同步，额度暂未知</p></div>}</div>
    {a.error && <div className="card-error"><AlertCircle size={14}/><span>{a.error}</span></div>}
    {removing && <div className="remove-confirm"><p>从保险库移除？目标客户端登录不受影响。</p><button className="text-button danger" disabled={disabled} onClick={onRemove}>确认移除</button><button className="text-button" onClick={() => setRemoving(false)}>取消</button></div>}
    <div className="card-footer"><span className={`sync-time ${stale ? 'stale' : ''}`}><span className={`dot ${stale ? 'amber' : 'green'}`}/>{ago(a.syncedAt, now)}{stale && a.syncedAt ? ' · 旧数据' : ''}</span><button className={`switch-button ${a.isTarget ? 'is-current' : ''}`} disabled={disabled || a.isTarget} onClick={() => onSwitch(true)}>{a.isTarget ? <><Check size={14}/>本地已选</> : <>切换并重启<ArrowRightLeft size={14}/></>}</button></div>
  </article>;
}
function AddPanel({ disabled, start, importFile, importCurrent }: { disabled: boolean; start(label: string, method: string): void; importFile(): void; importCurrent(): void }) { const [label, setLabel] = useState(''); const [method, setMethod] = useState('browser'); return <><div className="modal-symbol"><Plus size={27}/></div><div className="eyebrow">MAKE ROOM FOR MORE</div><h2>添加 ChatGPT 账号</h2><p className="modal-description">个人与商业账号，都可以拥有自己的位置。</p><label className="field-label">账号备注 <span>可选</span><input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：个人 Pro / 工作 Business" maxLength={80}/></label><div className="login-methods"><button className={method === 'browser' ? 'selected' : ''} onClick={() => setMethod('browser')}><ExternalLink size={16}/>浏览器授权</button><button className={method === 'device' ? 'selected' : ''} onClick={() => setMethod('device')}><Command size={16}/>设备代码</button></div><button className="button primary wide" disabled={disabled} onClick={() => start(label, method)}><LogIn size={17}/>使用 ChatGPT 登录<ArrowUpRight size={16}/></button><p className="login-hint">在官方登录页选择账号和工作空间。设备代码方式须在账号或组织中启用。</p><div className="divider"><span>或导入已有登录</span></div><div className="import-options"><button disabled={disabled} onClick={importCurrent}><Download size={18}/><strong>当前 Codex 登录</strong><small>从目标本地缓存导入</small></button><button disabled={disabled} onClick={importFile}><FolderOpen size={18}/><strong>选择 auth.json</strong><small>从登录文件导入</small></button></div><div className="privacy-line"><ShieldCheck size={14}/>不收集密码 · 登录凭据在本机加密保存</div></>; }
function SettingsPanel({ initial, busy, canRestore, save, pick, restore, detect }: { initial: Settings; busy: boolean; canRestore: boolean; save(patch: Partial<Settings>): void; pick(kind: string): Promise<Result<string | null>>; restore(): void; detect(): Promise<Result | null> }) {
  const [settings, setSettings] = useState(initial);
  useEffect(() => setSettings(initial), [initial.cliPath, initial.desktopPath, initial.codexHome, initial.pollSeconds, initial.autoSync, initial.lowResource]);
  async function choose(key: 'cliPath' | 'desktopPath' | 'codexHome') { const r = await pick(key); if (r.ok && r.value) setSettings(s => ({ ...s, [key]: r.value! })); }
  return <div className="settings-layout"><section className="panel"><div className="panel-heading"><Settings2 size={19}/><h2>本机连接</h2></div><p className="panel-intro">自动检测的路径可直接使用，也可以连接另一份 Codex 安装。</p>{([['cliPath', 'Codex CLI', '用于官方登录与额度查询，选择 codex.exe。'], ['desktopPath', '目标桌面客户端', '用于识别退出状态和重启，选择 Codex.exe 或 ChatGPT.exe。'], ['codexHome', '目标 CODEX_HOME', '切换此目录中的 auth.json；默认是用户目录下的 .codex。']] as const).map(([key, title, hint]) => <div className="setting-field" key={key}><label htmlFor={key}>{title}</label><div><input id={key} value={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.value })}/><button className="button" disabled={busy} onClick={() => choose(key)}><FolderOpen size={16}/>选择</button></div><small>{hint}</small></div>)}<button className="text-button" disabled={busy} onClick={detect}><RefreshCw size={14}/>重新检测官方安装</button><p className="workflow-hint">账号与设置保存在本机用户数据目录，更新后自动保留。手动指定路径时保留自定义设置。</p><div className="settings-divider"/><div className="toggle-row"><div><strong>自动同步额度</strong><p>打开应用时自动刷新，关闭应用后停止。</p></div><button role="switch" aria-checked={settings.autoSync} aria-label="自动同步额度" className={`toggle ${settings.autoSync ? 'on' : ''}`} onClick={() => setSettings({ ...settings, autoSync: !settings.autoSync })}><span/></button></div><div className="toggle-row"><div><strong>低资源模式</strong><p>后台减少同步，工作流按需检查，合并流式界面更新。</p></div><button role="switch" aria-checked={settings.lowResource} aria-label="低资源模式" className={`toggle ${settings.lowResource ? 'on' : ''}`} onClick={() => setSettings({ ...settings, lowResource: !settings.lowResource })}><span/></button></div><div className="interval-row"><label htmlFor="interval">同步间隔</label><select id="interval" value={settings.pollSeconds} onChange={e => setSettings({ ...settings, pollSeconds: Number(e.target.value) })}>{[30, 60, 120, 300, 600].map(v => <option key={v} value={v}>{v} 秒</option>)}</select></div><button className="button primary" disabled={busy} onClick={() => { const patch: Partial<Settings> = { pollSeconds: settings.pollSeconds, autoSync: settings.autoSync, lowResource: settings.lowResource }; for (const key of ['cliPath', 'desktopPath', 'codexHome'] as const) if (settings[key] !== initial[key]) patch[key] = settings[key]; save(patch); }}><Check size={16}/>保存设置</button></section><aside className="settings-aside"><section className="panel"><ShieldCheck size={23}/><h3>登录状态受到保护</h3><p>保险库通过 Windows DPAPI 加密。切换前保留一份加密备份，便于恢复。</p><button className="button wide" disabled={busy || !canRestore} onClick={restore}><RotateCcw size={15}/>恢复上次切换</button><small>恢复前请退出目标客户端。凭据已更新时不会覆盖。</small></section><section className="compatibility-note"><AlertCircle size={18}/><strong>兼容性说明</strong><p>目标须使用文件登录存储。若配置了 keyring、auto 或 ephemeral，请先将 cli_auth_credentials_store 设置为 "file" 并重新登录。组织管理策略仍然生效。</p><p>桌面程序若有独立登录存储，缓存切换可能不生效；以目标客户端显示的账号为准。</p></section></aside></div>;
}
