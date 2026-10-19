import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeError } from './core.mjs';

const ACTIVE = new Set(['monitoring', 'checking', 'switching', 'resuming', 'running', 'approval', 'waiting']);
const CONTINUE = '继续本会话刚刚中断且尚未完成的原始工作。先检查会话历史、现有文件、工具执行结果和任务进度，核对已完成与未完成的部分，从中断位置继续；不要重复已经成功完成的操作。需要使用工具时，使用当前环境实际可用的工具。保持原始任务范围、项目目录与权限要求。如果原始需求已经全部完成，报告结果并停止。';
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const PENDING_TOOLS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']);
export function transientInterruption(error) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const kind = typeof info === 'string' ? info : info && Object.keys(info)[0];
  if ([401, 403].includes(info?.[kind]?.httpStatusCode)) return false;
  return ['internalServerError', 'serverOverloaded', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind);
}
export function selectAutomaticTarget(entries, { after = 0, scope = '', handled = [] } = {}) {
  const valid = entries.filter(({ thread, turn }) => {
    if (!thread || !turn || thread.parentThreadId || thread.ephemeral || !path.isAbsolute(thread.cwd || '')) return false;
    if (scope) { const relative = path.relative(scope, thread.cwd); if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false; }
    const timestamp = (Math.max(turn.completedAt || 0, turn.startedAt || 0) || thread.updatedAt || 0) * 1000;
    if ((turn.status !== 'inProgress' && timestamp < after) || handled.includes(`${thread.id}:${turn.id}`)) return false;
    return turn.status === 'inProgress' || turn.status === 'interrupted' || (turn.status === 'failed' && (quotaError(turn.error) || transientInterruption(turn.error)));
  });
  const recency = entry => Math.max(entry.turn.completedAt || 0, entry.turn.startedAt || 0) || entry.thread.updatedAt || 0;
  valid.sort((a, b) => Number(b.turn.status === 'inProgress') - Number(a.turn.status === 'inProgress') || recency(b) - recency(a) || a.thread.id.localeCompare(b.thread.id));
  return valid[0] || null;
}
export function pendingExecution(turn, thread) {
  return (thread?.status?.activeFlags ?? []).some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ||
    (turn?.items ?? []).some(item => PENDING_TOOLS.has(item.type) && ['inProgress', 'running'].includes(item.status));
}
export function desktopOwnsActiveTask(thread) {
  return /^(Codex Desktop|codex[_-]desktop)$/i.test(thread?.originator || '');
}
export function quotaError(error) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const kind = typeof info === 'string' ? info : info && Object.keys(info)[0];
  return ['usageLimitExceeded', 'rateLimitExceeded', 'usage_limit_exceeded', 'rate_limit_exceeded'].includes(kind) || /you[’']ve hit your usage limit|you have (?:exceeded|reached) your usage limit|usage limit (?:reached|exceeded)/i.test(error?.message || '');
}
export function quotaState(account, bucketId, now = Date.now(), freshness = 120000) {
  if (!account || account.error || !account.syncedAt || now - account.syncedAt > freshness) return 'unknown';
  const bucket = account.limits.find(b => b.id === bucketId);
  if (!bucket || !bucket.windows.length || bucket.windows.some(w => w.remaining === null)) return 'unknown';
  return bucket.windows.some(w => w.remaining <= 0) ? 'exhausted' : 'available';
}
export function nextAccount(accounts, workflow, now = Date.now(), freshness = 120000, current = null) {
  return workflow.accountIds.map(id => accounts.find(a => a.id === id)).find(a =>
    a && (!current || (a.id !== current.id && a.identity !== current.identity)) && (!workflow.cooldowns[a.id] || workflow.cooldowns[a.id] <= now) && quotaState(a, workflow.bucketId, now, freshness) === 'available');
}

export function observedEntry(thread, turn, writers) {
  const writerBusy = writers.busy.includes(thread.id);
  // A separate app-server reconstructs unfinished live history as interrupted. It has no live turn state.
  if (writerBusy && !turn.completedAt && ['interrupted', 'inProgress'].includes(turn.status)) {
    return { thread: { ...thread, writerBusy }, turn: { ...turn, historyStatus: turn.status, status: 'inProgress' } };
  }
  return { thread: { ...thread, writerBusy }, turn };
}

export class WorkflowEngine {
  constructor(service) { this.service = service; this.generation = 0; this.busy = false; this.lastChecks = new Map(); }
  get all() { return this.service.data.workflows ?? []; }
  get active() { return this.all.find(w => ACTIVE.has(w.status)); }
  snapshot() { return this.all.map(({ cooldowns, ...w }) => ({ ...w, lastCheckedAt: this.lastChecks.get(w.id), approval: null, executor: 'desktop' })); }
  find(id) { const w = this.all.find(x => x.id === id); if (!w) throw new Error('工作流不存在。'); return w; }
  assertOwnership(id) { if (this.active && this.active.id !== id) throw new Error('自动工作流正在使用登录状态，请先暂停工作流。'); }
  usesAccount(id) { return this.all.some(w => ACTIVE.has(w.status) && w.accountIds.includes(id)); }
  async recover() {
    for (const w of this.all) {
      w.cooldowns ??= {}; w.handledTurns ??= []; w.attemptedSources ??= [];
      if (w.policyVersion !== 2) {
        // Never silently reactivate a workflow that was stopped after an erroneous restart.
        w.status = 'paused'; w.message = '误重启修复已安装，监控保持暂停；重新启用后只在确认原任务额度失败时切到其他账号。';
        w.policyVersion = 2; w.dispatchId = null; w.source = null; w.binding = null;
        if (w.mode === 'new' && w.threadId) w.mode = 'existing';
      } else if (ACTIVE.has(w.status)) w.status = w.dispatchId ? 'resuming' : 'monitoring';
    }
    await this.service.vault.save();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.service.stopping && this.active) this.timer = setTimeout(() => this.tick().catch(() => {}), this.service.data.settings.lowResource ? 15000 : 5000);
  }
  async persist(w, status, message) {
    if (w.status !== status || w.message !== message) w.updatedAt = Date.now();
    w.status = status; w.message = message;
    await this.service.vault.save(); this.service.publish(); this.schedule(); this.service.schedule();
  }
  async withHistory(operation) {
    const s = this.service; await s.refreshRuntimePaths();
    const rpc = new s.Rpc(s.data.settings.cliPath, s.data.settings.codexHome, { ephemeral: true }); s.sessions.add(rpc);
    try { await rpc.initialize(); return await operation(rpc); }
    finally { await rpc.close(); s.sessions.delete(rpc); }
  }
  history(method, params) { return this.withHistory(rpc => rpc.call(method, params)); }
  async turns(rpc, threadId, limit = 1) {
    try { return (await rpc.call('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'full' })).data ?? []; }
    catch (error) {
      if (!/not supported|unsupported|paginated|legacy|not implemented|unknown variant|method not found/i.test(error.message)) throw error;
      return (await rpc.call('thread/read', { threadId, includeTurns: true })).thread.turns?.slice(-limit).reverse() ?? [];
    }
  }
  latestTurn(threadId) { return this.withHistory(async rpc => (await this.turns(rpc, threadId))[0] || null); }
  writers() { return this.service.platform.threadWriters(this.service.data.settings.codexHome); }
  async inspect(w) {
    const writers = await this.writers();
    return this.withHistory(async rpc => {
      const list = await rpc.call('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
        archived: false, modelProviders: [], sourceKinds: ['appServer', 'cli', 'exec', 'vscode', 'unknown'] });
      const threads = new Map(list.data.map(t => [t.id, t]));
      for (const id of [...writers.busy, ...(w.threadId ? [w.threadId] : [])]) if (!threads.has(id)) {
        try { threads.set(id, (await rpc.call('thread/read', { threadId: id, includeTurns: false })).thread); }
        catch { writers.unknown = true; }
      }
      const entries = [];
      for (const thread of threads.values()) {
        try { const turn = (await this.turns(rpc, thread.id))[0]; if (turn) entries.push(observedEntry(thread, turn, writers)); }
        catch { if (writers.busy.includes(thread.id)) writers.unknown = true; }
      }
      const active = entries.filter(e => e.turn.status === 'inProgress');
      const pinned = (w.dispatchId || w.following || w.mode === 'existing') && w.threadId;
      const selected = pinned ? entries.find(e => e.thread.id === w.threadId) : selectAutomaticTarget(entries, {
        after: w.scanAfter ?? Date.now() - LOOKBACK_MS, scope: w.scope, handled: [...(w.handledTurns || []), ...(w.attemptedSources || [])] });
      return { selected, active, unknown: writers.unknown };
    });
  }
  async automaticTarget(w) { return (await this.inspect(w)).selected; }
  async threads() {
    const { data } = await this.history('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, modelProviders: [] });
    return data.filter(t => !t.parentThreadId).map(t => ({ id: t.id, name: t.name || t.preview?.slice(0, 80) || t.id, cwd: t.cwd }));
  }
  async create(input) {
    const s = this.service;
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('请输入工作流名称。');
    if (!['auto', 'existing'].includes(input.mode)) throw new Error('请在官方客户端创建任务；本工具只负责账号接力。');
    if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 50 || new Set(input.accountIds).size !== input.accountIds.length) throw new Error('请按优先级选择候选账号。');
    input.accountIds.forEach(id => s.find(id));
    let cwd = input.cwd || '', threadId = null;
    if (input.mode === 'existing') {
      if (!/^[0-9a-f-]{36}$/i.test(input.threadId || '')) throw new Error('请选择有效的本地会话。');
      const { thread } = await this.history('thread/read', { threadId: input.threadId, includeTurns: false });
      if (thread.parentThreadId || thread.ephemeral) throw new Error('请选择持久化主会话。');
      cwd = thread.cwd; threadId = thread.id;
    }
    if (cwd && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())) throw new Error('请选择存在的项目目录。');
    const w = { id: randomUUID(), name: input.name.trim().slice(0, 80), mode: input.mode, policyVersion: 2, executor: 'desktop', cwd, threadId,
      accountIds: input.accountIds, bucketId: /^[a-zA-Z0-9_.-]{1,100}$/.test(input.bucketId || '') ? input.bucketId : 'codex',
      status: 'paused', message: '已创建，等待启动。', accountId: null, turnId: null, dispatchId: null, cooldowns: {},
      switchCount: 0, output: '', updatedAt: Date.now(), home: s.data.settings.codexHome, scope: input.mode === 'auto' ? cwd : '',
      scanAfter: Date.now() - LOOKBACK_MS, handledTurns: [], attemptedSources: [], completedCount: 0 };
    s.data.workflows.push(w); await s.vault.save(); s.publish(); return w.id;
  }
  async start(id) {
    if (this.busy) throw new Error('工作流正在检查，请稍后重试。');
    this.assertOwnership(id); const w = this.find(id);
    if (ACTIVE.has(w.status)) return;
    if (w.home !== this.service.data.settings.codexHome) throw new Error('目标 CODEX_HOME 已改变，请重新创建工作流。');
    if (!['auto', 'existing'].includes(w.mode)) throw new Error('请在官方客户端创建任务。');
    this.generation++; w.retryAfter = 0; w.armedAt = Date.now(); w.binding = null;
    if (!w.dispatchId) { w.following = false; w.source = null; if (w.mode === 'auto') { w.threadId = null; w.cwd = w.scope || ''; } }
    await this.persist(w, w.dispatchId ? 'resuming' : 'monitoring', '监控已启用；运行中的任务不会被打断，确认额度失败后才切换到其他账号。');
    this.tick().catch(() => {});
  }
  async pause(id) {
    const w = this.find(id); this.generation++;
    await this.persist(w, 'paused', '自动监控已暂停，官方客户端保持运行。');
    if (w.dispatchId && w.ownsDispatch) {
      const { data } = await this.history('thread/queue/list', { threadId: w.threadId, limit: 100 }).catch(() => ({ data: [] }));
      const queued = data.find(q => q.clientUserMessageId === w.dispatchId);
      if (queued) await this.history('thread/queue/delete', { threadId: w.threadId, queuedSubmissionId: queued.id }).catch(() => {});
      w.dispatchId = null; await this.service.vault.save();
    }
  }
  async remove(id) {
    const w = this.find(id); if (ACTIVE.has(w.status)) throw new Error('请先暂停工作流。');
    this.service.data.workflows = this.all.filter(x => x !== w); await this.service.vault.save(); this.service.publish();
  }
  async reconcile(w, generation) {
    const result = await this.withHistory(async rpc => {
      const turns = await this.turns(rpc, w.threadId, 8);
      const turn = turns.find(t => t.items?.some(i => i.type === 'userMessage' && (i.clientId === w.dispatchId || i.id === w.dispatchId)));
      const { data } = await rpc.call('thread/queue/list', { threadId: w.threadId, limit: 100 });
      return { turn, latest: turns[0], queued: data.find(q => q.clientUserMessageId === w.dispatchId) };
    });
    if (generation !== this.generation) return false;
    if (result.turn) {
      w.turnId = result.turn.id; w.dispatchId = null; w.following = true;
      this.service.event(`已在原会话 ${w.threadId} 确认官方客户端接收继续指令`);
      await this.persist(w, 'running', '已在原会话中确认继续指令，任务由官方客户端执行。'); return true;
    }
    if (result.latest && result.latest.id !== w.turnId) {
      // A different user turn is not acknowledgement of our queued message.
      if (result.queued && w.ownsDispatch) await this.history('thread/queue/delete', { threadId: w.threadId, queuedSubmissionId: result.queued.id });
      w.dispatchId = null;
      await this.persist(w, 'needs_attention', '原会话出现其他新指令，已停止接力，不把其他回合当成恢复成功。'); return false;
    }
    if (Date.now() - (w.dispatchAt || 0) > 90000 || (w.wakeAttempts || 0) >= 3) {
      await this.persist(w, 'needs_attention', '尚未在原会话确认继续指令，已停止重试；不会再次切号或重启。'); return false;
    }
    const writers = await this.writers();
    if (result.queued && !writers.busy.includes(w.threadId) && Date.now() - (w.lastWakeAt || 0) >= 30000) await this.wakeDesktop(w);
    await this.persist(w, 'resuming', '等待官方客户端接收原会话消息；尚未确认恢复，不重复切号或重启。'); return false;
  }
  async tick() {
    if (this.busy || this.service.stopping) return;
    const w = this.active; if (!w) return;
    if (w.retryAfter > Date.now()) { this.schedule(); return; }
    this.busy = true; const generation = this.generation;
    try {
      this.lastChecks.set(w.id, Date.now());
      const target = await this.service.target();
      const current = this.service.data.accounts.find(a => a.identity === target?.identity);
      if (w.dispatchId && !await this.reconcile(w, generation)) return;
      const state = await this.inspect(w);
      if (generation !== this.generation) return;
      const selected = state.selected;
      if (!selected) { await this.persist(w, 'monitoring', state.active.length ? '其他会话仍在运行，不恢复历史中断任务。' : '等待活动任务或已确认停止的中断任务。'); return; }
      const { thread, turn } = selected;
      w.observedTarget = { name: thread.name || thread.preview?.slice(0, 60) || thread.id, threadId: thread.id, cwd: thread.cwd, status: turn.status };
      if (turn.status === 'inProgress') {
        if (current && desktopOwnsActiveTask(thread)) w.binding = { threadId: thread.id, turnId: turn.id, accountId: current.id };
        if (current && (!current.syncedAt || Date.now() - current.syncedAt >= 30000)) await this.service.syncAll([current.id]);
        if (generation !== this.generation) return;
        await this.persist(w, w.following ? 'running' : 'monitoring', '原任务仍由运行进程持有，继续监控；不会因历史显示中断或面板显示 0% 而重启。'); return;
      }
      if (turn.status === 'completed') {
        if (w.following) w.completedCount++;
        if (w.mode === 'auto') { this.release(w); await this.persist(w, 'monitoring', '原会话已完成，继续监控。'); }
        else await this.persist(w, 'completed', '原会话已完成。'); return;
      }
      if (state.unknown || state.active.some(e => e.thread.id !== thread.id)) { await this.persist(w, 'monitoring', '还有任务正在运行或运行状态无法确认，保持客户端和登录不变。'); return; }
      if (!current) { await this.persist(w, 'waiting', '无法确认当前登录账号，保持客户端和登录不变。'); return; }
      await this.service.syncAll([current.id]);
      if (generation !== this.generation) return;
      const quota = turn.status === 'failed' && quotaError(turn.error);
      const currentState = quotaState(current, w.bucketId, Date.now(), 60000);
      if (quota) {
        const bound = w.binding?.threadId === thread.id && w.binding?.turnId === turn.id && w.binding?.accountId === current.id;
        if (currentState !== 'exhausted' || !bound) {
          await this.persist(w, 'monitoring', currentState !== 'exhausted' ? '历史额度错误与当前账号额度不符，不切号、不重启。' : '尚未确认额度失败属于当前账号正在监控的回合，保持客户端不变。'); return;
        }
        this.cooldown(w, current);
        for (const id of w.accountIds.filter(id => id !== current.id && (!w.cooldowns[id] || w.cooldowns[id] <= Date.now()))) {
          if (quotaState(this.service.find(id), w.bucketId, Date.now(), 60000) !== 'available') await this.service.syncAll([id]);
          if (nextAccount(this.service.data.accounts, w, Date.now(), 60000, current)) break;
        }
        const next = nextAccount(this.service.data.accounts, w, Date.now(), 60000, current);
        if (!next) { await this.persist(w, 'waiting', '没有其他可用账号，等待额度恢复；不会切回当前账号重启。'); return; }
        if (Date.now() - (w.lastRestartAt || 0) < 120000) { await this.persist(w, 'waiting', '已触发重启间隔保护，稍后重新核对；不会连续重启。'); return; }
        await this.handoff(w, selected, current, next, generation);
      } else if (turn.status === 'interrupted' || (turn.status === 'failed' && transientInterruption(turn.error))) {
        if (thread.writerBusy) { await this.persist(w, 'monitoring', '会话仍被运行进程持有，保持客户端不变。'); return; }
        if (w.following) { await this.persist(w, 'needs_attention', '刚续接的原会话再次中断，已停止接力，避免重复干预。'); return; }
        if (currentState !== 'available') { await this.persist(w, 'waiting', '当前账号额度未知或耗尽，但原任务没有确认额度失败；不会据此换号。'); return; }
        await this.handoff(w, selected, current, current, generation);
      } else await this.persist(w, 'needs_attention', '原任务需要在官方客户端处理，保持登录和客户端不变。');
    } catch (error) {
      if (generation === this.generation) {
        const attempted = w.attemptedSources.includes(`${w.threadId}:${w.turnId}`);
        await this.persist(w, w.dispatchId ? 'resuming' : attempted ? 'needs_attention' : 'monitoring', `检查暂未完成，保持原会话${attempted ? '，停止重复接力' : '并稍后重试'}：${safeError(error)}`);
        w.retryAfter = Date.now() + 15000;
      }
    } finally { this.busy = false; await this.restoreDesktop(); this.schedule(); }
  }
  cooldown(w, a) {
    const windows = a.limits.find(b => b.id === w.bucketId)?.windows ?? [];
    w.cooldowns[a.id] = Math.max(...windows.filter(x => x.remaining === 0 && x.resetsAt).map(x => x.resetsAt * 1000), Date.now() + 60000);
  }
  async handoff(w, selected, current, account, generation) {
    const s = this.service, { thread, turn } = selected;
    const source = `${thread.id}:${turn.id}`;
    if (w.attemptedSources.includes(source)) { await this.persist(w, 'needs_attention', '这一回合已尝试接力，不重复提交或重启。'); return; }
    const rotate = account.identity !== current.identity;
    if (!path.isAbsolute(thread.cwd || '') || !(await stat(thread.cwd)).isDirectory()) throw new Error('原项目目录不可用，已取消接力。');
    const fresh = await this.inspect({ ...w, threadId: thread.id, mode: 'existing' });
    const latest = fresh.selected;
    if (generation !== this.generation) return;
    if (!latest || latest.turn.id !== turn.id || latest.turn.status === 'inProgress' || latest.turn.status === 'completed' || fresh.unknown || fresh.active.length) {
      await this.persist(w, 'monitoring', '会话仍在运行或状态已变化，不提交继续指令、不重启。'); return;
    }
    if ((await s.target())?.identity !== current.identity) throw new Error('当前账号发生变化，已取消接力。');
    w.threadId = thread.id; w.cwd = thread.cwd; w.turnId = turn.id;
    w.source = { threadId: thread.id, turnId: turn.id, status: turn.status, name: thread.name || thread.preview?.slice(0, 60) || thread.id };
    w.attemptedSources = [...w.attemptedSources, source].slice(-100);
    let exe = s.data.settings.desktopPath;
    if (s.platform.resolveDesktop) exe = await s.platform.resolveDesktop(exe);
    if (!exe || !(await stat(exe)).isFile()) throw new Error('官方客户端路径无效。');
    s.data.settings.desktopPath = exe;
    if (rotate) {
      if (account.id === current.id || quotaState(current, w.bucketId, Date.now(), 60000) !== 'exhausted' || latest.turn.status !== 'failed' || !quotaError(latest.turn.error)) throw new Error('未满足额度切号条件，客户端保持不变。');
      await s.checkTargetConfig();
      if (generation !== this.generation) return;
      w.lastRestartAt = Date.now();
      await this.persist(w, 'switching', `已确认原回合额度失败，准备切换到其他账号「${account.label}」。`);
      if (generation !== this.generation) return;
      if (await s.platform.desktopRunning(exe)) await s.platform.closeDesktop(exe);
      this.desktopOwned = { threadId: thread.id, home: w.home };
      if (generation !== this.generation) return;
      const after = await this.latestTurn(thread.id);
      if (!after || after.id !== turn.id || after.status !== 'failed' || !quotaError(after.error)) throw new Error('退出时原回合已变化，已取消切换。');
      if ((await s.target())?.identity !== current.identity) throw new Error('退出时登录已变化，已取消切换。');
      await s.switchAccount(account.id, false, w.id); w.switchCount++;
    }
    if (generation !== this.generation) return;
    w.accountId = account.id; w.dispatchId = randomUUID(); w.ownsDispatch = true; w.dispatchAt = Date.now(); w.wakeAttempts = 0;
    await this.persist(w, 'resuming', rotate ? '已切到其他账号，正在打开并等待原会话接收指令。' : '只在原会话提交继续指令，账号和运行中的客户端保持不变。');
    const dispatchId = w.dispatchId;
    await this.withHistory(async rpc => {
      const { data } = await rpc.call('thread/queue/list', { threadId: w.threadId, limit: 100 });
      if (generation !== this.generation) return;
      if (data.length) { w.dispatchId = data[0].clientUserMessageId; w.ownsDispatch = false; return; }
      const result = await rpc.call('thread/queue/add', { threadId: w.threadId, clientUserMessageId: dispatchId, input: [{ type: 'text', text: CONTINUE }] });
      w.queuedSubmissionId = result.queuedSubmission?.id;
      if (generation !== this.generation && w.queuedSubmissionId) await rpc.call('thread/queue/delete', { threadId: w.threadId, queuedSubmissionId: w.queuedSubmissionId });
    });
    if (generation !== this.generation) return;
    await this.wakeDesktop(w);
    if (generation === this.generation) await this.persist(w, 'resuming', '已定位原会话，等待确认对应继续消息被官方客户端接收。');
  }
  async wakeDesktop(w) {
    w.lastWakeAt = Date.now(); w.wakeAttempts = (w.wakeAttempts || 0) + 1; await this.service.vault.save();
    await this.service.platform.launchDesktop(this.service.data.settings.desktopPath, { threadId: w.threadId, home: w.home }); this.desktopOwned = null;
  }
  async open(id) {
    const w = this.find(id), threadId = w.threadId || w.observedTarget?.threadId;
    if (!threadId) throw new Error('尚未选择会话。');
    await this.service.platform.launchDesktop(this.service.data.settings.desktopPath, { threadId, home: w.home, wake: false });
  }
  release(w) {
    if (w.source) w.handledTurns = [...w.handledTurns, `${w.source.threadId}:${w.source.turnId}`].slice(-100);
    w.source = null; w.observedTarget = null; w.following = false; w.dispatchId = null; w.binding = null;
    w.threadId = null; w.turnId = null; w.cwd = w.scope || ''; w.scanAfter = Date.now() - 1000;
  }
  async restoreDesktop() {
    if (!this.desktopOwned) return;
    try { await this.service.platform.launchDesktop(this.service.data.settings.desktopPath, { ...this.desktopOwned, wake: false }); this.desktopOwned = null; }
    catch { /* Retain the original thread so the next retry reopens it, not the home screen. */ }
  }
  async approve() { throw new Error('请在官方客户端处理审批。'); }
  async dispose() { clearTimeout(this.timer); this.timer = null; this.generation++; await this.restoreDesktop(); }
}
