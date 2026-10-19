import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeError } from './core.mjs';

const ACTIVE = new Set(['monitoring', 'checking', 'switching', 'running', 'approval', 'waiting']);
const CONTINUE = '继续本会话刚刚中断且尚未完成的原始工作。先检查会话历史、现有文件、工具执行结果和任务进度，核对已完成与未完成的部分，从中断位置继续；不要重复已经成功完成的操作。需要使用工具时，使用当前环境实际可用的工具。保持原始任务范围、项目目录与权限要求。如果原始需求已经全部完成，报告结果并停止。';
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const PENDING_TOOLS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']);
export function transientInterruption(error) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const kind = typeof info === 'string' ? info : info && Object.keys(info)[0];
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
export function nextAccount(accounts, workflow, now = Date.now(), freshness = 120000) {
  return workflow.accountIds.map(id => accounts.find(a => a.id === id)).find(a =>
    a && (!workflow.cooldowns[a.id] || workflow.cooldowns[a.id] <= now) && quotaState(a, workflow.bucketId, now, freshness) === 'available');
}

// Queue storage never loads/resumes a thread here. Only the official desktop owns execution.
export class WorkflowEngine {
  constructor(service) { this.service = service; this.generation = 0; this.busy = false; this.turnCache = new Map(); this.lastChecks = new Map(); }
  get all() { return this.service.data.workflows ?? []; }
  get active() { return this.all.find(w => ACTIVE.has(w.status)); }
  snapshot() { return this.all.map(({ cooldowns, ...w }) => ({ ...w, lastCheckedAt: this.lastChecks.get(w.id), approval: null, executor: 'desktop' })); }
  assertOwnership(id) { if (this.active && this.active.id !== id) throw new Error('自动工作流正在使用登录状态，请先暂停工作流。'); }
  usesAccount(id) { return this.all.some(w => ACTIVE.has(w.status) && w.accountIds.includes(id)); }
  async recover() {
    for (const w of this.all) {
      w.cooldowns ??= {}; w.handledTurns ??= []; w.scanAfter ??= Date.now() - LOOKBACK_MS;
      if (w.executor !== 'desktop') {
        w.executor = 'desktop'; w.dispatchId = null; w.source = null;
        if (w.mode === 'new') {
          if (w.threadId) w.mode = 'existing';
          else { w.status = 'needs_attention'; w.message = '请先在官方客户端创建任务，再启用自动接力。'; continue; }
        }
        if (ACTIVE.has(w.status) || w.status === 'needs_attention') { w.status = 'monitoring'; w.message = '已升级为官方客户端接力，正在重新检查原会话。'; }
      } else if (ACTIVE.has(w.status)) {
        // A persisted queue ID is reconciled with desktop history, never blindly replayed.
        w.status = w.dispatchId ? 'running' : 'monitoring';
      }
    }
    await this.service.vault.save();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (this.service.stopping || !this.active) return;
    const delay = this.service.data.settings.lowResource ? 15000 : 5000;
    this.timer = setTimeout(() => this.tick().catch(() => {}), delay);
  }
  async persist(w, status, message) {
    if (w.status !== status || w.message !== message) w.updatedAt = Date.now();
    w.status = status; w.message = message;
    await this.service.vault.save(); this.service.publish();
    this.schedule(); this.service.schedule();
  }
  find(id) { const w = this.all.find(x => x.id === id); if (!w) throw new Error('工作流不存在。'); return w; }
  async withHistory(operation) {
    const s = this.service; await s.refreshRuntimePaths();
    const rpc = new s.Rpc(s.data.settings.cliPath, s.data.settings.codexHome, { ephemeral: true });
    s.sessions.add(rpc);
    try { await rpc.initialize(); return await operation(rpc); }
    finally { await rpc.close(); s.sessions.delete(rpc); }
  }
  history(method, params) { return this.withHistory(rpc => rpc.call(method, params)); }
  async latest(rpc, threadId) {
    try {
      const { data } = await rpc.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
      return data?.[0] || null;
    } catch (error) {
      if (!/not supported|unsupported|paginated|legacy|not implemented|unknown variant|method not found/i.test(error.message)) throw error;
      const { thread } = await rpc.call('thread/read', { threadId, includeTurns: true });
      return thread.turns?.at(-1) || null;
    }
  }
  latestTurn(threadId) { return this.withHistory(rpc => this.latest(rpc, threadId)); }
  async automaticTarget(w) {
    return this.withHistory(async rpc => {
      const result = await rpc.call('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
        archived: false, modelProviders: [], sourceKinds: ['appServer', 'cli', 'exec', 'vscode', 'unknown'] });
      const entries = []; let failures = 0;
      for (const thread of result.data) {
        if (thread.parentThreadId || thread.ephemeral) continue;
        if (w.scope) { const relative = path.relative(w.scope, thread.cwd || ''); if (relative.startsWith('..') || path.isAbsolute(relative)) continue; }
        try { if (!(await stat(thread.cwd)).isDirectory()) continue; } catch { continue; }
        const cached = this.turnCache.get(thread.id);
        let turn;
        if (cached && cached.updatedAt === thread.updatedAt && cached.turn?.status === 'completed' && Date.now() - cached.checkedAt < 15000) turn = cached.turn;
        else {
          try { turn = await this.latest(rpc, thread.id); }
          catch { failures++; continue; } // One unreadable thread must not disable all monitoring.
          this.turnCache.set(thread.id, { updatedAt: thread.updatedAt, checkedAt: Date.now(), turn });
          if (this.turnCache.size > 120) this.turnCache.delete(this.turnCache.keys().next().value);
        }
        if (turn) entries.push({ thread, turn });
      }
      if (!entries.length && failures) throw new Error('本地会话暂时无法读取，后台将自动重试。');
      return selectAutomaticTarget(entries, { after: w.scanAfter, scope: w.scope, handled: w.handledTurns });
    });
  }
  async threads() {
    const result = await this.history('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, modelProviders: [] });
    return result.data.filter(t => !t.parentThreadId).map(t => ({ id: t.id, name: t.name || t.preview?.slice(0, 80) || t.id, cwd: t.cwd }));
  }
  async create(input) {
    const s = this.service;
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('请输入工作流名称。');
    if (!['auto', 'existing'].includes(input.mode)) throw new Error('请在官方客户端创建任务；本工具只负责切号并重启官方客户端续接。');
    if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 50 || new Set(input.accountIds).size !== input.accountIds.length) throw new Error('请按优先级选择至少一个账号。');
    input.accountIds.forEach(id => s.find(id));
    let cwd = input.cwd || '', threadId = null;
    if (input.mode === 'existing') {
      if (typeof input.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.threadId)) throw new Error('请选择有效的本地会话。');
      const { thread } = await this.history('thread/read', { threadId: input.threadId, includeTurns: false });
      if (thread.parentThreadId || thread.ephemeral) throw new Error('请选择持久化的主会话。');
      cwd = thread.cwd; threadId = thread.id;
    }
    if (cwd && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())) throw new Error('请选择存在的项目目录。');
    const w = { id: randomUUID(), name: input.name.trim().slice(0, 80), mode: input.mode, executor: 'desktop', cwd, threadId,
      accountIds: input.accountIds, bucketId: typeof input.bucketId === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(input.bucketId) ? input.bucketId : 'codex',
      status: 'paused', message: '已创建，等待启动。', accountId: null, turnId: null, dispatchId: null,
      cooldowns: {}, switchCount: 0, output: '', updatedAt: Date.now(), home: s.data.settings.codexHome,
      scope: input.mode === 'auto' ? cwd : '', scanAfter: Date.now() - LOOKBACK_MS, handledTurns: [], source: null, completedCount: 0 };
    s.data.workflows.push(w); await s.vault.save(); s.publish(); return w.id;
  }
  async start(id) {
    if (this.busy) throw new Error('工作流正在执行操作，请稍后重试。');
    this.assertOwnership(id); const w = this.find(id);
    if (ACTIVE.has(w.status)) { this.tick().catch(() => {}); return; }
    if (w.home !== this.service.data.settings.codexHome) throw new Error('目标 CODEX_HOME 已改变，请创建对应目录的新工作流。');
    this.generation++; w.executor = 'desktop'; w.retryAfter = 0;
    if (w.mode === 'new') throw new Error('请先在官方客户端创建任务，再选择会话进行接力。');
    await this.persist(w, w.dispatchId ? 'running' : 'monitoring', '后台监控已启用：达到限额后自动切号、重启官方客户端并继续原会话。');
    this.tick().catch(() => {});
  }
  async pause(id) {
    const w = this.find(id); this.generation++;
    await this.persist(w, 'paused', '已停止自动切号。官方客户端中的任务继续运行；如需停止任务，请在官方客户端操作。');
    await this.restoreDesktop();
  }
  async remove(id) {
    const w = this.find(id); if (ACTIVE.has(w.status)) throw new Error('请先暂停工作流。');
    this.service.data.workflows = this.all.filter(x => x !== w); await this.service.vault.save(); this.service.publish();
  }
  freshness() { return 90000; }
  async tick() {
    if (this.busy || this.service.stopping) return;
    const w = this.active; if (!w) return;
    if (w.retryAfter && w.retryAfter > Date.now()) { this.schedule(); return; }
    this.busy = true; const generation = this.generation;
    try {
      this.lastChecks.set(w.id, Date.now());
      const target = await this.service.target();
      const current = this.service.data.accounts.find(a => a.identity === target?.identity);
      // Current-account polling is independent of general UI sync intervals (which can be an hour).
      if (current && (!current.syncedAt || Date.now() - current.syncedAt >= 15000)) await this.service.syncAll([current.id]);
      if (generation !== this.generation) return;
      let selected;
      if (w.dispatchId) {
        const turn = await this.latestTurn(w.threadId);
        const queue = await this.history('thread/queue/list', { threadId: w.threadId, limit: 100 });
        const queued = queue.data.find(q => q.clientUserMessageId === w.dispatchId);
        if (turn && turn.id !== w.turnId) { w.dispatchId = null; w.turnId = turn.id; w.wakeAttempts = 0; }
        else if (queued) {
          if (Date.now() - (w.lastWakeAt || 0) >= 30000) {
            if ((w.wakeAttempts || 0) >= 4) { await this.persist(w, 'needs_attention', '官方客户端尚未接收继续指令。消息仍在原会话队列，请检查官方客户端的登录或错误提示。'); return; }
            await this.wakeDesktop(w);
          }
          await this.persist(w, 'running', '已重新打开官方客户端，正在等待它接收原会话的继续指令。'); return;
        } else if (Date.now() - (w.lastWakeAt || 0) < 30000) return;
        else { await this.persist(w, 'needs_attention', '继续指令的执行结果暂无法确认，请在官方客户端核对原会话。'); return; }
        selected = turn && { thread: { id: w.threadId, cwd: w.cwd, originator: 'Codex Desktop' }, turn };
      } else if (w.mode === 'existing' || w.source) {
        const turn = await this.latestTurn(w.threadId);
        selected = turn && { thread: { id: w.threadId, cwd: w.cwd, originator: 'Codex Desktop' }, turn };
      } else selected = await this.automaticTarget(w);
      if (generation !== this.generation) return;
      if (!selected) { await this.persist(w, 'monitoring', '正在后台监控；等待活动任务或最近 24 小时内中断的工作。'); return; }
      const { thread, turn } = selected;
      w.observedTarget = { name: thread.name || thread.id, threadId: thread.id, cwd: thread.cwd, status: turn.status };
      const exhausted = quotaState(current, w.bucketId, Date.now(), this.freshness()) === 'exhausted';
      const quota = quotaError(turn.error);
      if (turn.status === 'completed') {
        if (w.mode === 'auto') { this.releaseAutomaticTarget(w, true); await this.persist(w, 'monitoring', '原会话已在官方客户端完成，继续后台监控。'); }
        else await this.persist(w, 'completed', '原会话已在官方客户端完成。');
        return;
      }
      if (turn.status === 'inProgress' && !desktopOwnsActiveTask(thread)) { await this.persist(w, 'monitoring', '活动任务由独立 CLI 或 IDE 持有，等待其中断后再在官方客户端继续。'); return; }
      if (turn.status === 'inProgress' && (pendingExecution(turn, thread) || (!exhausted && !quota))) {
        await this.persist(w, 'monitoring', pendingExecution(turn, thread) ? '正在执行工具或等待官方客户端审批，结束后自动接力。' : '正在跟随官方客户端任务，后台每 15 秒检查额度和任务状态。'); return;
      }
      if (!(exhausted || quota || turn.status === 'interrupted' || (turn.status === 'failed' && transientInterruption(turn.error)))) {
        await this.persist(w, 'needs_attention', `原会话停止：${safeError(turn.error?.message || turn.status)}。请在官方客户端处理。`); return;
      }
      if ((quota || exhausted) && current && w.rejectedTurn !== `${current.id}:${turn.id}`) {
        this.cooldown(w, current); w.rejectedTurn = `${current.id}:${turn.id}`;
      }
      if (!quota && !exhausted && (w.recoveryAttempts || 0) >= 3) { await this.persist(w, 'needs_attention', '原任务连续中断，请在官方客户端检查原因。'); return; }
      // Refresh candidate accounts only when a handoff is required; failed accounts cannot block observing the current task.
      const eligible = w.accountIds.filter(id => !w.cooldowns[id] || w.cooldowns[id] <= Date.now());
      for (const id of eligible) {
        if (quotaState(this.service.find(id), w.bucketId, Date.now(), this.freshness()) !== 'available') await this.service.syncAll([id]);
        if (nextAccount(this.service.data.accounts, w, Date.now(), this.freshness())) break;
      }
      if (generation !== this.generation) return;
      const account = nextAccount(this.service.data.accounts, w, Date.now(), this.freshness());
      if (!account) { await this.persist(w, 'waiting', '候选账号暂无可用额度；保持官方客户端打开，后台等待恢复后自动接力。'); return; }
      w.threadId = thread.id; w.cwd = thread.cwd; w.turnId = turn.id;
      w.source = { threadId: thread.id, turnId: turn.id, status: turn.status, name: thread.name || thread.id };
      w.accountId = current?.id || w.accountId;
      await this.run(w, account, generation);
      if (!quota && !exhausted) w.recoveryAttempts = (w.recoveryAttempts || 0) + 1;
      else w.recoveryAttempts = 0;
    } catch (error) {
      if (generation === this.generation) {
        if (w.status === 'switching') await this.persist(w, w.dispatchId ? 'running' : 'waiting', `切换暂未完成，后台将自动重试：${safeError(error)}`);
        else await this.persist(w, w.dispatchId ? 'running' : 'monitoring', `监控暂时失败，后台将自动重试：${safeError(error)}`);
        w.retryAfter = Date.now() + 15000;
      }
    } finally {
      this.busy = false; await this.restoreDesktop(); this.schedule();
    }
  }
  cooldown(w, a) {
    const windows = a.limits.find(b => b.id === w.bucketId)?.windows ?? [];
    w.cooldowns[a.id] = Math.max(...windows.filter(x => x.remaining === 0 && x.resetsAt).map(x => x.resetsAt * 1000), Date.now() + 60000);
  }
  async run(w, account, generation) {
    const s = this.service; await s.checkTargetConfig();
    let exe = s.data.settings.desktopPath;
    if (s.platform.resolveDesktop) exe = await s.platform.resolveDesktop(exe);
    if (!exe || !(await stat(exe)).isFile()) throw new Error('请设置有效的官方桌面客户端路径。');
    const before = await this.latestTurn(w.threadId);
    if (!before || before.id !== w.turnId || before.status === 'completed' || (before.status === 'inProgress' && pendingExecution(before))) {
      if (w.mode === 'auto') this.releaseAutomaticTarget(w, false);
      await this.persist(w, 'monitoring', '目标状态已变化，继续监控官方客户端。'); return;
    }
    await this.persist(w, 'switching', `正在退出官方客户端并切换至「${account.label}」…`);
    if (await s.platform.desktopRunning(exe)) await s.platform.closeDesktop(exe);
    this.desktopOwned = true; s.data.settings.desktopPath = exe;
    if (generation !== this.generation) return;
    const after = await this.latestTurn(w.threadId);
    if (!after || after.id !== w.turnId || after.status === 'completed') {
      if (w.mode === 'auto') this.releaseAutomaticTarget(w, after?.status === 'completed');
      await this.persist(w, 'monitoring', '退出时任务状态已变化，重新打开官方客户端并继续监控。'); return;
    }
    await s.switchAccount(account.id, false, w.id);
    if (generation !== this.generation) return;
    if (w.accountId && w.accountId !== account.id) w.switchCount++;
    w.accountId = account.id;
    const id = randomUUID();
    // Persist intent first, then store exactly one dormant queue message without thread/resume or turn/start.
    w.dispatchId = id; w.wakeAttempts = 0;
    await s.vault.save();
    await this.withHistory(async rpc => {
      const queue = await rpc.call('thread/queue/list', { threadId: w.threadId, limit: 100 });
      // Respect the user's existing queued follow-up instead of adding another instruction behind it.
      if (queue.data.length) { w.dispatchId = queue.data[0].clientUserMessageId; return; }
      await rpc.call('thread/queue/add', { threadId: w.threadId, clientUserMessageId: id, input: [{ type: 'text', text: CONTINUE }] });
    });
    if (generation !== this.generation) return;
    await this.wakeDesktop(w);
    if (generation !== this.generation) return;
    s.event(`已切换至「${account.label}」，重启官方客户端续接原会话 ${w.threadId}`);
    await this.persist(w, 'running', `已切换至「${account.label}」并重新打开官方客户端，原会话由官方客户端继续执行。`);
  }
  async wakeDesktop(w) {
    // Save before launching so restart/crash recovery can reconcile the same queued message.
    w.lastWakeAt = Date.now(); w.wakeAttempts = (w.wakeAttempts || 0) + 1;
    await this.service.vault.save();
    await this.service.platform.launchDesktop(this.service.data.settings.desktopPath, { threadId: w.threadId, home: w.home });
    this.desktopOwned = false;
  }
  releaseAutomaticTarget(w, completed) {
    if (w.source) w.handledTurns = [...(w.handledTurns || []), `${w.source.threadId}:${w.source.turnId}`].slice(-100);
    if (completed) w.completedCount = (w.completedCount || 0) + 1;
    w.scanAfter = Date.now() - 1000; w.source = null; w.observedTarget = null;
    w.threadId = null; w.turnId = null; w.dispatchId = null; w.cwd = w.scope || '';
    w.recoveryAttempts = 0; this.turnCache.clear();
  }
  async restoreDesktop() {
    if (!this.desktopOwned) return;
    const { platform, data } = this.service;
    try { await platform.launchDesktop(data.settings.desktopPath, { home: data.settings.codexHome }); this.desktopOwned = false; }
    catch { /* Keep ownership so the next tick retries launching the official client. */ }
  }
  async approve() { throw new Error('请在官方客户端处理审批；本工具不执行项目任务。'); }
  async dispose() { clearTimeout(this.timer); this.timer = null; this.generation++; await this.restoreDesktop(); }
}
