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
      w.cooldowns ??= {}; w.handledTurns ??= []; w.attemptedSources ??= []; w.bindings ??= {};
      if (w.policyVersion !== 2) {
        // Never silently reactivate a workflow that was stopped after an erroneous restart.
        w.status = 'paused'; w.message = '工作流已暂停，点击启动即可使用。';
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
      const failed = entries.filter(e => selectAutomaticTarget([e], { scope: w.scope, handled: [...(w.handledTurns || []), ...(w.attemptedSources || [])] }) && e.turn.status === 'failed' && quotaError(e.turn.error) &&
        (w.bindings?.[e.thread.id]?.accountId === w.accountId || (e.turn.completedAt || e.turn.startedAt || 0) * 1000 >= (w.armedAt || Date.now())))
        .sort((a,b) => (b.turn.completedAt || b.turn.startedAt || 0) - (a.turn.completedAt || a.turn.startedAt || 0));
      const selected = pinned ? entries.find(e => e.thread.id === w.threadId) : failed[0] || selectAutomaticTarget(entries, {
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
      switchCount: 0, output: '', bindings: {}, updatedAt: Date.now(), home: s.data.settings.codexHome, scope: input.mode === 'auto' ? cwd : '',
      scanAfter: Date.now() - LOOKBACK_MS, handledTurns: [], attemptedSources: [], completedCount: 0 };
    s.data.workflows.push(w); await s.vault.save(); s.publish(); return w.id;
  }
  async start(id) {
    if (this.busy) throw new Error('工作流正在检查，请稍后重试。');
    this.assertOwnership(id); const w = this.find(id);
    if (ACTIVE.has(w.status)) return;
    if (w.home !== this.service.data.settings.codexHome) throw new Error('目标 CODEX_HOME 已改变，请重新创建工作流。');
    if (!['auto', 'existing'].includes(w.mode)) throw new Error('请在官方客户端创建任务。');
    this.generation++; w.retryAfter = 0; w.armedAt = Date.now(); w.binding = null; w.bindings = {};
    if (!w.dispatchId) { w.following = false; w.source = null; if (w.mode === 'auto') { w.threadId = null; w.cwd = w.scope || ''; } }
    await this.persist(w, w.dispatchId ? 'resuming' : 'monitoring', '已开启自动接力。');
    this.tick().catch(() => {});
  }
  async pause(id) {
    const w = this.find(id); this.generation++;
    await this.persist(w, 'paused', '自动接力已暂停。');
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
      await this.persist(w, 'running', '原任务已继续运行。'); return true;
    }
    if (result.latest && result.latest.id !== w.turnId) {
      // A different user turn is not acknowledgement of our queued message.
      if (result.queued && w.ownsDispatch) await this.history('thread/queue/delete', { threadId: w.threadId, queuedSubmissionId: result.queued.id });
      w.dispatchId = null;
      await this.persist(w, 'needs_attention', '原会话收到了新消息，接力已停止。'); return false;
    }
    if (Date.now() - (w.dispatchAt || 0) > 90000 || (w.wakeAttempts || 0) >= 3) {
      await this.persist(w, 'needs_attention', 'ChatGPT 没有接收继续指令，接力已停止。'); return false;
    }
    const writers = await this.writers();
    if (result.queued && !writers.busy.includes(w.threadId) && Date.now() - (w.lastWakeAt || 0) >= 30000) await this.wakeDesktop(w);
    await this.persist(w, 'resuming', '等待 ChatGPT 接收继续指令…'); return false;
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
      if (current) {
        w.accountId = current.id;
        for (const entry of state.active) if (desktopOwnsActiveTask(entry.thread)) w.bindings[entry.thread.id] = { accountId: current.id, turnId: entry.turn.id, seenAt: Date.now() };
      }
      if (generation !== this.generation) return;
      const selected = state.selected;
      if (!selected) { await this.persist(w, 'monitoring', state.active.length ? '任务正在运行。' : '等待任务开始。'); return; }
      const { thread, turn } = selected;
      w.observedTarget = { name: thread.name || thread.preview?.slice(0, 60) || thread.id, threadId: thread.id, cwd: thread.cwd, status: turn.status };
      if (turn.status === 'inProgress') {
        if (current && desktopOwnsActiveTask(thread)) w.binding = { threadId: thread.id, turnId: turn.id, accountId: current.id };
        if (current && (!current.syncedAt || Date.now() - current.syncedAt >= 30000)) await this.service.syncAll([current.id]);
        if (generation !== this.generation) return;
        await this.persist(w, w.following ? 'running' : 'monitoring', '任务正在运行。'); return;
      }
      if (turn.status === 'completed') {
        if (w.following) w.completedCount++;
        if (w.mode === 'auto') { this.release(w); await this.persist(w, 'monitoring', '原会话已完成，继续监控。'); }
        else await this.persist(w, 'completed', '原会话已完成。'); return;
      }
      const quota = turn.status === 'failed' && quotaError(turn.error);
      if (state.unknown || state.active.some(e => e.thread.id !== thread.id && (!quota || pendingExecution(e.turn, e.thread)))) {
        await this.persist(w, 'monitoring', '等正在执行的任务结束后接力。'); return;
      }
      if (!current) { await this.persist(w, 'waiting', '找不到当前账号，请先导入登录。'); return; }
      await this.service.syncAll([current.id]);
      if (generation !== this.generation) return;
      const currentState = quotaState(current, w.bucketId, Date.now(), 60000);
      if (quota) {
        const bound = w.bindings[thread.id]?.accountId === current.id && w.bindings[thread.id]?.turnId === turn.id;
        // A fresh failure after activation also counts; a fast quota rejection can happen between polls.
        const recent = (turn.completedAt || turn.startedAt || 0) * 1000 >= Math.max(w.armedAt || Date.now(), Date.now() - 300000);
        if (currentState !== 'exhausted' || (!bound && !recent)) {
          await this.persist(w, 'monitoring', currentState !== 'exhausted' ? '当前账号还有额度，继续监控。' : '找到旧的限额记录，等待当前任务状态更新。'); return;
        }
        this.cooldown(w, current);
        for (const id of w.accountIds.filter(id => id !== current.id && (!w.cooldowns[id] || w.cooldowns[id] <= Date.now()))) {
          if (quotaState(this.service.find(id), w.bucketId, Date.now(), 60000) !== 'available') await this.service.syncAll([id]);
          if (nextAccount(this.service.data.accounts, w, Date.now(), 60000, current)) break;
        }
        const next = nextAccount(this.service.data.accounts, w, Date.now(), 60000, current);
        if (!next) { await this.persist(w, 'waiting', '账号额度已用完，等待恢复。'); return; }
        if (Date.now() - (w.lastRestartAt || 0) < 120000) { await this.persist(w, 'waiting', '稍后重试切换。'); return; }
        await this.handoff(w, selected, current, next, generation);
      } else if (turn.status === 'interrupted' || (turn.status === 'failed' && transientInterruption(turn.error))) {
        if (thread.writerBusy) { await this.persist(w, 'monitoring', '任务正在运行。'); return; }
        if (w.following) { await this.persist(w, 'needs_attention', '原任务再次中断，接力已停止。'); return; }
        if (currentState !== 'available') { await this.persist(w, 'waiting', '正在刷新账号额度…'); return; }
        await this.handoff(w, selected, current, current, generation);
      } else await this.persist(w, 'needs_attention', '请打开原会话查看任务消息。');
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
    if (w.attemptedSources.includes(source)) { await this.persist(w, 'needs_attention', '这次接力失败，请打开原会话查看。'); return; }
    const rotate = account.identity !== current.identity;
    if (!path.isAbsolute(thread.cwd || '') || !(await stat(thread.cwd)).isDirectory()) throw new Error('原项目目录不可用，已取消接力。');
    const fresh = await this.inspect({ ...w, threadId: thread.id, mode: 'existing' });
    const latest = fresh.selected;
    if (generation !== this.generation) return;
    if (!latest || latest.turn.id !== turn.id || latest.turn.status === 'inProgress' || latest.turn.status === 'completed' || fresh.unknown || fresh.active.some(e => !rotate || pendingExecution(e.turn, e.thread))) {
      await this.persist(w, 'monitoring', '任务状态已更新，重新检查中…'); return;
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
      this.desktopOwned = { threadId: thread.id, home: w.home };
      if (generation !== this.generation) return;
      await s.switchAccount(account.id, true, w.id, { threadId: thread.id, wake: false, beforeWrite: async () => {
        if (generation !== this.generation) throw new Error('工作流已暂停。');
        const after = await this.latestTurn(thread.id);
        if (!after || after.id !== turn.id || after.status !== 'failed' || !quotaError(after.error)) throw new Error('原任务状态已更新，取消这次切换。');
        if ((await s.target())?.identity !== current.identity) throw new Error('账号已被其他操作更改。');
      } });
      this.desktopOwned = null; w.switchCount++;
    }
    if (generation !== this.generation) return;
    w.accountId = account.id; w.dispatchId = randomUUID(); w.ownsDispatch = true; w.dispatchAt = Date.now(); w.wakeAttempts = 0;
    await this.persist(w, 'resuming', rotate ? '客户端已重启，正在继续原会话…' : '正在继续原会话…');
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
    if (generation === this.generation) await this.persist(w, 'resuming', '等待 ChatGPT 接收继续指令…');
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
