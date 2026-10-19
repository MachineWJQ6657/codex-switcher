import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeError } from './core.mjs';

const ACTIVE = new Set(['monitoring', 'checking', 'switching', 'running', 'approval', 'waiting']);
const IN_FLIGHT = new Set(['checking', 'switching', 'running', 'approval']);
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
  return ['usageLimitExceeded', 'rateLimitExceeded', 'usage_limit_exceeded', 'rate_limit_exceeded'].includes(error?.codexErrorInfo ?? error?.codex_error_info);
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

export class WorkflowEngine {
  constructor(service) { this.service = service; this.runner = null; this.generation = 0; this.busy = false; this.turnCache = new Map(); }
  get all() { return this.service.data.workflows ?? []; }
  get active() { return this.all.find(w => ACTIVE.has(w.status)); }
  snapshot() { return this.all.map(({ cooldowns, ...w }) => ({ ...w, approval: this.runner?.workflowId === w.id ? this.runner.approval : null })); }
  assertOwnership(id) { if (this.active && this.active.id !== id) throw new Error('自动工作流正在使用登录状态，请先暂停工作流。'); }
  usesAccount(id) { return this.all.some(w => ACTIVE.has(w.status) && w.accountIds.includes(id)); }
  async recover() {
    for (const w of this.all) if (IN_FLIGHT.has(w.status)) { w.status = 'needs_attention'; w.message = '上次运行意外中断，请核对会话和文件后手动继续。不会自动重放已提交的操作。'; }
    await this.service.vault.save();
  }
  schedule() {
    clearTimeout(this.timer);
    const w = this.active;
    if (this.service.stopping || !w || !['monitoring', 'waiting'].includes(w.status)) return;
    const low = this.service.data.settings.lowResource;
    let delay = low ? 60000 : 15000;
    if (low && w.status === 'waiting') {
      const resets = w.accountIds.flatMap(id => {
        const a = this.service.data.accounts.find(a => a.id === id);
        if (!a || a.error || !a.syncedAt) return [];
        return (a.limits.find(b => b.id === w.bucketId)?.windows ?? []).filter(x => x.remaining === 0 && x.resetsAt).map(x => x.resetsAt * 1000 - Date.now());
      }).filter(x => x > 0);
      if (resets.length === w.accountIds.length) delay = Math.max(60000, Math.min(300000, Math.min(...resets)));
    }
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
    // Read persisted metadata without joining or starting a turn on the desktop's live server.
    const s = this.service; await s.refreshRuntimePaths();
    const rpc = new s.Rpc(s.data.settings.cliPath, s.data.settings.codexHome, { ephemeral: true });
    s.sessions.add(rpc);
    try { await rpc.initialize(); return await operation(rpc); }
    finally { await rpc.close(); s.sessions.delete(rpc); }
  }
  history(method, params) { return this.withHistory(rpc => rpc.call(method, params)); }
  async automaticTarget(w) {
    return this.withHistory(async rpc => {
      const result = await rpc.call('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
        archived: false, modelProviders: [], sourceKinds: ['appServer', 'cli', 'exec', 'vscode', 'unknown'] });
      const entries = [];
      for (const thread of result.data) {
        if (thread.parentThreadId || thread.ephemeral) continue;
        if (w.scope) { const relative = path.relative(w.scope, thread.cwd || ''); if (relative.startsWith('..') || path.isAbsolute(relative)) continue; }
        try { if (!(await stat(thread.cwd)).isDirectory()) continue; } catch { continue; }
        const cached = this.turnCache.get(thread.id);
        let turn;
        if (cached && cached.updatedAt === thread.updatedAt && Date.now() - cached.checkedAt < (cached.turn?.status === 'inProgress' ? 15000 : 300000)) turn = cached.turn;
        else {
          const { data } = await rpc.call('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
          turn = data?.[0]; this.turnCache.set(thread.id, { updatedAt: thread.updatedAt, checkedAt: Date.now(), turn });
          if (this.turnCache.size > 120) this.turnCache.delete(this.turnCache.keys().next().value);
        }
        if (turn) entries.push({ thread, turn });
      }
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
    if (!['auto', 'new', 'existing'].includes(input.mode)) throw new Error('工作流模式无效。');
    if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 50 || new Set(input.accountIds).size !== input.accountIds.length) throw new Error('请按优先级选择至少一个账号。');
    input.accountIds.forEach(id => s.find(id));
    let cwd = input.cwd, threadId = null;
    if (input.mode === 'existing') {
      if (typeof input.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.threadId)) throw new Error('请选择有效的本地会话。');
      const { thread } = await this.history('thread/read', { threadId: input.threadId, includeTurns: false });
      if (thread.parentThreadId || thread.ephemeral) throw new Error('请选择持久化的主会话。');
      cwd = thread.cwd; threadId = thread.id;
    } else if (input.mode === 'new' && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000)) throw new Error('请输入任务内容（最多 20000 字）。');
    if (input.mode !== 'auto' || cwd) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('请选择存在的项目目录。');
    } else cwd = '';
    const w = { id: randomUUID(), name: input.name.trim().slice(0, 80), mode: input.mode, cwd, threadId,
      prompt: input.mode === 'new' ? input.prompt.trim() : '', accountIds: input.accountIds,
      bucketId: typeof input.bucketId === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(input.bucketId) ? input.bucketId : 'codex',
      status: 'paused', message: '已创建，等待启动。', accountId: null, turnId: null, dispatchId: null,
      cooldowns: {}, switchCount: 0, output: '', updatedAt: Date.now(), home: s.data.settings.codexHome,
      scope: input.mode === 'auto' ? cwd : '', scanAfter: Date.now() - LOOKBACK_MS, handledTurns: [], source: null, completedCount: 0 };
    s.data.workflows.push(w); await s.vault.save(); s.publish(); return w.id;
  }
  async start(id) {
    if (this.busy) throw new Error('工作流正在执行操作，请稍后重试。');
    this.assertOwnership(id); const w = this.find(id);
    if (ACTIVE.has(w.status)) return;
    if (w.home !== this.service.data.settings.codexHome) throw new Error('目标 CODEX_HOME 已改变，请创建对应目录的新工作流。');
    this.generation++;
    // Existing conversations are watched until an actual quota failure at a terminal boundary.
    if (w.mode === 'auto' && !w.source) await this.persist(w, 'monitoring', '全自动接力已启用：优先监控活动任务，没有活动任务时恢复最近中断的工作。');
    else if (w.mode === 'existing' && !w.dispatchId) await this.persist(w, 'monitoring', '正在监控本地会话；仅在额度错误导致任务失败后接管续接。');
    else await this.persist(w, 'waiting', '准备检查账号额度并运行任务。');
    this.tick().catch(() => {});
  }
  async pause(id) {
    const w = this.find(id); this.generation++;
    await this.stopRunner();
    await this.persist(w, 'paused', '工作流已暂停；继续前请核对已执行的操作。');
    if (!this.busy) await this.restoreDesktop();
  }
  async remove(id) {
    const w = this.find(id); if (ACTIVE.has(w.status)) throw new Error('请先暂停工作流。');
    this.service.data.workflows = this.all.filter(x => x !== w); await this.service.vault.save(); this.service.publish();
  }
  async tick() {
    if (this.busy || this.service.stopping) return;
    const w = this.active; if (!w || !['monitoring', 'waiting'].includes(w.status)) return;
    if (w.retryAfter && w.retryAfter > Date.now()) { this.schedule(); return; }
    this.busy = true; const generation = this.generation;
    try {
      await this.service.syncAll(w.accountIds, true);
      if (generation !== this.generation) return;
      if (w.status === 'monitoring' && w.mode === 'auto') {
        const target = await this.service.target();
        const current = this.service.data.accounts.find(a => a.identity === target?.identity);
        if (!current || !w.accountIds.includes(current.id)) { await this.persist(w, 'monitoring', '等待候选账号成为目标客户端当前登录。'); return; }
        const selected = await this.automaticTarget(w);
        if (generation !== this.generation) return;
        if (!selected) { await this.persist(w, 'monitoring', '未找到活动或最近 24 小时内中断的任务，继续等待。'); return; }
        const { thread, turn } = selected;
        const quota = quotaError(turn.error);
        const exhausted = quotaState(current, w.bucketId, Date.now(), Math.max(120000, this.service.data.settings.pollSeconds * 2000)) === 'exhausted';
        if (turn.status === 'inProgress' && !desktopOwnsActiveTask(thread)) {
          w.observedTarget = { name: thread.name || thread.id, threadId: thread.id, cwd: thread.cwd, status: turn.status };
          await this.persist(w, 'monitoring', '活动任务由独立 CLI 或 IDE 持有；等待其结束或中断后续接，避免同一会话被两个进程执行。'); return;
        }
        if (turn.status === 'inProgress' && (!exhausted || pendingExecution(turn, thread))) {
          w.observedTarget = { name: thread.name || thread.id, threadId: thread.id, cwd: thread.cwd, status: turn.status };
          await this.persist(w, 'monitoring', pendingExecution(turn, thread) ? '检测到活动任务，等待正在执行的工具或审批结束后接力。' : '正在跟随活动任务；账号额度耗尽后自动切换并恢复此会话。'); return;
        }
        w.threadId = thread.id; w.cwd = thread.cwd; w.turnId = turn.id; w.accountId = current.id;
        w.source = { threadId: thread.id, turnId: turn.id, status: turn.status, name: thread.name || thread.id, selectedAt: Date.now() };
        if (quota || exhausted) this.cooldown(w, current);
        await this.persist(w, 'waiting', turn.status === 'inProgress' ? '当前账号额度耗尽，准备保存并重启活动任务。' : '没有活动任务，准备恢复最近中断的工作。');
      } else if (w.status === 'monitoring') {
        const target = await this.service.target();
        const a = this.service.data.accounts.find(a => a.identity === target?.identity);
        if (!a || !w.accountIds.includes(a.id)) return;
        const { data: turns } = await this.history('thread/turns/list', { threadId: w.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
        const turn = turns?.[0];
        if (!turn || turn.status === 'inProgress') return;
        if (turn.status === 'completed') { await this.persist(w, 'completed', '被监控会话已完成，无需切换或续接。'); return; }
        if (turn.status !== 'failed' || !quotaError(turn.error)) return;
        // Only structured Codex quota errors trigger account rotation. 429/network errors alone do not.
        this.cooldown(w, a); w.turnId = turn.id;
      }
      if (generation !== this.generation) return;
      const account = nextAccount(this.service.data.accounts, w, Date.now(), Math.max(120000, this.service.data.settings.pollSeconds * 2000));
      if (!account) { await this.persist(w, 'waiting', '所有候选账号额度耗尽、同步失败或额度未知；等待可用额度后自动继续。'); return; }
      await this.run(w, account, generation);
    } catch (error) {
      if (generation === this.generation) { await this.stopRunner(); await this.persist(w, 'needs_attention', safeError(error)); await this.restoreDesktop(); }
    } finally { this.busy = false; this.schedule(); if (generation !== this.generation && !this.active) await this.restoreDesktop(); }
  }
  cooldown(w, a) {
    const windows = a.limits.find(b => b.id === w.bucketId)?.windows ?? [];
    const reset = Math.max(...windows.filter(x => x.remaining === 0 && x.resetsAt).map(x => x.resetsAt * 1000), Date.now() + 60000);
    w.cooldowns[a.id] = reset; // Even a stale service response cannot immediately loop back to the rejected account.
  }
  async run(w, account, generation) {
    const s = this.service;
    await s.checkTargetConfig();
    await this.persist(w, 'switching', `正在接管项目并切换至「${account.label}」…`);
    let exe = s.data.settings.desktopPath;
    if (s.platform.resolveDesktop) exe = await s.platform.resolveDesktop(exe);
    if (!exe) throw new Error('请先设置目标桌面客户端路径。');
    if (!(await stat(exe)).isFile()) throw new Error('桌面客户端路径无效。');
    if (w.mode === 'auto' && w.source) {
      const { data } = await this.history('thread/turns/list', { threadId: w.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      const current = data?.[0];
      if (!current) throw new Error('无法确认目标会话状态，未关闭客户端。');
      if (current.id !== (w.turnId || w.source.turnId) || current.status === 'completed') {
        this.releaseAutomaticTarget(w, current.status === 'completed');
        await this.persist(w, 'monitoring', '目标任务已经完成或出现新指令，继续监控最新任务。'); return;
      }
      if (current.status === 'inProgress' && pendingExecution(current)) {
        w.source = null; w.threadId = null; w.turnId = null; w.cwd = w.scope || '';
        await this.persist(w, 'monitoring', '目标仍有工具正在执行，稍后在任务边界自动接力。'); return;
      }
    }
    if (await s.platform.desktopRunning(exe)) await s.platform.closeDesktop(exe);
    this.desktopOwned = true;
    if (generation !== this.generation) return;
    if (w.mode === 'auto' && w.source) {
      // Closing can flush a completed turn or a new user message. Never resume a superseded task.
      const { data } = await this.history('thread/turns/list', { threadId: w.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      const latest = data?.[0];
      if (!latest) throw new Error('无法确认目标会话的最新状态，未发送继续指令。');
      if (latest.status === 'completed' || latest.id !== (w.turnId || w.source.turnId)) {
        this.releaseAutomaticTarget(w, latest?.status === 'completed');
        await this.persist(w, 'monitoring', '切换前任务状态已经变化，已重新开启客户端并继续监控。');
        await this.restoreDesktop(); return;
      }
    }
    s.data.settings.desktopPath = exe;
    await s.switchAccount(account.id, false, w.id);
    if (generation !== this.generation) return;
    if (w.accountId && w.accountId !== account.id) w.switchCount++;
    w.accountId = account.id;
    const rpc = new s.Rpc(s.data.settings.cliPath, w.home);
    const runner = { rpc, workflowId: w.id, generation, approval: null, completed: [], ready: false, changes: new Map() };
    this.runner = runner; s.sessions.add(rpc);
    rpc.on('notification', msg => this.notification(runner, msg));
    rpc.on('request', msg => this.request(runner, msg));
    rpc.once('closed', () => {
      if (this.runner === runner && !s.stopping) {
        this.runner = null; s.sessions.delete(rpc);
        this.persist(w, 'needs_attention', '执行进程已断开，执行结果不确定；请核对后手动继续。').catch(() => {});
      }
    });
    await rpc.initialize();
    if (w.threadId) {
      await rpc.call('thread/resume', { threadId: w.threadId, excludeTurns: true, cwd: w.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    } else {
      const { thread } = await rpc.call('thread/start', { cwd: w.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', ephemeral: false });
      w.threadId = thread.id;
    }
    if (generation !== this.generation) { await this.stopRunner(); return; }
    // Persist intent before dispatch. An unknown response is never retried automatically.
    const first = !w.dispatchId && w.mode === 'new'; w.dispatchId = randomUUID();
    await this.persist(w, 'running', `使用「${account.label}」执行，原会话与项目目录持续保留。`);
    const { turn } = await rpc.call('turn/start', { threadId: w.threadId, clientUserMessageId: w.dispatchId,
      input: [{ type: 'text', text: first ? w.prompt : CONTINUE }], cwd: w.cwd });
    w.turnId = turn.id; runner.ready = true;
    await s.vault.save(); s.publish();
    for (const msg of runner.completed) this.notification(runner, msg);
  }
  notification(runner, msg) {
    if (this.runner !== runner || runner.generation !== this.generation) return;
    const w = this.find(runner.workflowId), p = msg.params ?? {};
    if (p.threadId && p.threadId !== w.threadId) return;
    if (['item/started', 'item/completed'].includes(msg.method) && p.item?.type === 'fileChange') runner.changes.set(p.item.id, p.item.changes);
    if (msg.method === 'item/agentMessage/delta') {
      w.output = safeError(`${w.output}${String(p.delta ?? '')}`, 12000).slice(-6000);
      if (!runner.outputTimer) runner.outputTimer = setTimeout(() => { runner.outputTimer = null; this.service.publish(); }, this.service.data.settings.lowResource ? 1000 : 250);
    }
    if (msg.method !== 'turn/completed') return;
    if (!runner.ready) { runner.completed.push(msg); return; }
    if (p.turn?.id !== w.turnId) return;
    // Handle one terminal event exactly once, including duplicate delivery.
    if (runner.finishing) return; runner.finishing = true;
    this.finish(runner, p.turn).catch(async error => { await this.stopRunner(); await this.persist(w, 'needs_attention', safeError(error)); });
  }
  async finish(runner, turn) {
    const w = this.find(runner.workflowId), s = this.service;
    await this.stopRunner(false);
    if (runner.generation !== this.generation) return;
    if (turn.status === 'failed' && quotaError(turn.error)) {
      w.recoveryAttempts = 0;
      this.cooldown(w, s.find(w.accountId));
      s.event(`工作流「${w.name}」额度耗尽，保留会话 ${w.threadId} 并准备切号`);
      await this.persist(w, 'waiting', '当前账号额度耗尽，正在选择下一个可用账号。');
      // tick's lock may still cover turn/start's response; the periodic tick also retries.
      queueMicrotask(() => this.tick().catch(() => {}));
    } else if (w.mode === 'auto' && (turn.status === 'interrupted' || (turn.status === 'failed' && transientInterruption(turn.error))) && (w.recoveryAttempts || 0) < 3) {
      w.recoveryAttempts = (w.recoveryAttempts || 0) + 1;
      w.retryAfter = Date.now() + Math.min(60000, 15000 * w.recoveryAttempts);
      await this.persist(w, 'waiting', `工作再次中断，已保留原会话，将自动继续（${w.recoveryAttempts}/3）。`);
    } else {
      if (turn.status === 'completed' && w.mode === 'auto') {
        this.releaseAutomaticTarget(w, true);
        await this.persist(w, 'monitoring', '中断的工作已完成，客户端已恢复，继续跟随之后的活动或中断任务。');
      } else await this.persist(w, turn.status === 'completed' ? 'completed' : 'needs_attention', turn.status === 'completed' ? '本轮任务已完成。会话历史已保存在原 CODEX_HOME。' : `任务停止：${safeError(turn.error?.message || turn.status)}，未触发自动切号。`);
      await this.restoreDesktop();
    }
  }
  releaseAutomaticTarget(w, completed) {
    if (w.source) w.handledTurns = [...(w.handledTurns || []), `${w.source.threadId}:${w.source.turnId}`].slice(-100);
    if (completed) w.completedCount = (w.completedCount || 0) + 1;
    w.scanAfter = Date.now() - 1000; w.source = null; w.observedTarget = null;
    w.threadId = null; w.turnId = null; w.dispatchId = null; w.cwd = w.scope || '';
    w.recoveryAttempts = 0; w.retryAfter = null;
    this.turnCache.clear();
  }
  async restoreDesktop() {
    if (!this.desktopOwned) return;
    this.desktopOwned = false;
    const { platform, data } = this.service;
    if (data.settings.desktopPath && !await platform.desktopRunning(data.settings.desktopPath)) await platform.launchDesktop(data.settings.desktopPath).catch(() => {});
  }
  request(runner, msg) {
    if (this.runner !== runner) return;
    const w = this.find(runner.workflowId);
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
      if (runner.approval) {
        runner.rpc.send({ id: msg.id, error: { code: -32000, message: 'Another approval is pending; pause and inspect before continuing.' } });
        this.pause(w.id).then(() => this.persist(w, 'needs_attention', '出现多个并发审批，请在原客户端核对后继续。')).catch(() => {}); return;
      }
      const decisions = msg.params?.availableDecisions;
      const files = runner.changes.get(msg.params?.itemId);
      const command = msg.method === 'item/fileChange/requestApproval' ? files?.map(f => `${f.path}\n${f.diff}`).join('\n\n') : msg.params?.command;
      const accept = (!decisions || decisions.includes('accept')) && typeof command === 'string' && command.length <= 20000;
      runner.approval = { requestId: msg.id, method: msg.method, command: safeError(command || '未获得完整的操作预览，请拒绝后回原客户端核对。', 20000), cwd: msg.params?.cwd || w.cwd, canAccept: accept };
      this.persist(w, 'approval', '执行需要你的审批，请检查命令或文件写入请求。').catch(() => {});
    } else {
      runner.rpc.send({ id: msg.id, error: { code: -32601, message: 'Workflow host cannot handle this interactive or host-specific tool. Return to the original client.' } });
      this.pause(w.id).then(() => this.persist(w, 'needs_attention', `原会话需要当前工作流不支持的交互或宿主工具：${msg.method}。请回到原客户端处理。`)).catch(() => {});
    }
  }
  async approve(id, requestId, accept) {
    const w = this.find(id), r = this.runner;
    if (!r || r.workflowId !== id || r.approval?.requestId !== requestId) throw new Error('审批请求已过期。');
    if (accept && !r.approval.canAccept) throw new Error('服务端未提供本次允许选项。');
    r.rpc.send({ id: requestId, result: { decision: accept ? 'accept' : 'decline' } }); r.approval = null;
    await this.persist(w, 'running', accept ? '已允许本次操作，继续执行。' : '已拒绝本次操作。');
  }
  async stopRunner(interrupt = true) {
    const r = this.runner; if (!r) return;
    this.runner = null;
    clearTimeout(r.outputTimer);
    const w = this.find(r.workflowId);
    if (interrupt && w.turnId && !r.finishing) await r.rpc.call('turn/interrupt', { threadId: w.threadId, turnId: w.turnId }, 5000).catch(() => {});
    await r.rpc.close(); this.service.sessions.delete(r.rpc);
  }
  async dispose() {
    clearTimeout(this.timer); this.generation++;
    const w = this.active;
    await this.stopRunner();
    await this.restoreDesktop();
    if (w && IN_FLIGHT.has(w.status)) await this.persist(w, 'needs_attention', '应用已退出，执行已中断；请核对项目后手动继续。');
  }
}
