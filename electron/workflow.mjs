import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeError } from './core.mjs';

const ACTIVE = new Set(['monitoring', 'checking', 'switching', 'running', 'approval', 'waiting']);
const IN_FLIGHT = new Set(['checking', 'switching', 'running', 'approval']);
const CONTINUE = '继续本会话中由于账号额度耗尽而未完成的原始任务。先检查现有文件、工具执行结果和任务进度，从中断位置继续；不要重复已经成功完成的操作。保持原始任务范围与权限要求。若任务实际上已经完成，报告结果并停止。';
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
  constructor(service) { this.service = service; this.runner = null; this.generation = 0; this.busy = false; }
  get all() { return this.service.data.workflows ?? []; }
  get active() { return this.all.find(w => ACTIVE.has(w.status)); }
  snapshot() { return this.all.map(({ cooldowns, ...w }) => ({ ...w, approval: this.runner?.workflowId === w.id ? this.runner.approval : null })); }
  assertOwnership(id) { if (this.active && this.active.id !== id) throw new Error('自动工作流正在使用登录状态，请先暂停工作流。'); }
  usesAccount(id) { return this.all.some(w => ACTIVE.has(w.status) && w.accountIds.includes(id)); }
  async recover() {
    for (const w of this.all) if (IN_FLIGHT.has(w.status)) { w.status = 'needs_attention'; w.message = '上次运行意外中断，请核对会话和文件后手动继续。不会自动重放已提交的操作。'; }
    await this.service.vault.save();
  }
  schedule() { this.timer = setInterval(() => this.tick().catch(() => {}), 15000); }
  async persist(w, status, message) {
    w.status = status; w.message = message; w.updatedAt = Date.now();
    await this.service.vault.save(); this.service.publish();
  }
  find(id) { const w = this.all.find(x => x.id === id); if (!w) throw new Error('工作流不存在。'); return w; }
  async history(method, params) {
    // Read persisted metadata without joining or starting a turn on the desktop's live server.
    const s = this.service, rpc = new s.Rpc(s.data.settings.cliPath, s.data.settings.codexHome, { ephemeral: true });
    s.sessions.add(rpc);
    try { await rpc.initialize(); return await rpc.call(method, params); }
    finally { await rpc.close(); s.sessions.delete(rpc); }
  }
  async threads() {
    const result = await this.history('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, modelProviders: [] });
    return result.data.filter(t => !t.parentThreadId).map(t => ({ id: t.id, name: t.name || t.preview?.slice(0, 80) || t.id, cwd: t.cwd }));
  }
  async create(input) {
    const s = this.service;
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('请输入工作流名称。');
    if (!['new', 'existing'].includes(input.mode)) throw new Error('工作流模式无效。');
    if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 50 || new Set(input.accountIds).size !== input.accountIds.length) throw new Error('请按优先级选择至少一个账号。');
    input.accountIds.forEach(id => s.find(id));
    let cwd = input.cwd, threadId = null;
    if (input.mode === 'existing') {
      if (typeof input.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.threadId)) throw new Error('请选择有效的本地会话。');
      const { thread } = await this.history('thread/read', { threadId: input.threadId, includeTurns: false });
      if (thread.parentThreadId || thread.ephemeral) throw new Error('请选择持久化的主会话。');
      cwd = thread.cwd; threadId = thread.id;
    } else if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new Error('请输入任务内容（最多 20000 字）。');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('请选择存在的项目目录。');
    const w = { id: randomUUID(), name: input.name.trim().slice(0, 80), mode: input.mode, cwd, threadId,
      prompt: input.mode === 'new' ? input.prompt.trim() : '', accountIds: input.accountIds,
      bucketId: typeof input.bucketId === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(input.bucketId) ? input.bucketId : 'codex',
      status: 'paused', message: '已创建，等待启动。', accountId: null, turnId: null, dispatchId: null,
      cooldowns: {}, switchCount: 0, output: '', updatedAt: Date.now(), home: s.data.settings.codexHome };
    s.data.workflows.push(w); await s.vault.save(); s.publish(); return w.id;
  }
  async start(id) {
    if (this.busy) throw new Error('工作流正在执行操作，请稍后重试。');
    this.assertOwnership(id); const w = this.find(id);
    if (ACTIVE.has(w.status)) return;
    if (w.home !== this.service.data.settings.codexHome) throw new Error('目标 CODEX_HOME 已改变，请创建对应目录的新工作流。');
    this.generation++;
    // Existing conversations are watched until an actual quota failure at a terminal boundary.
    if (w.mode === 'existing' && !w.dispatchId) await this.persist(w, 'monitoring', '正在监控本地会话；仅在额度错误导致任务失败后接管续接。');
    else await this.persist(w, 'waiting', '准备检查账号额度并运行任务。');
    this.tick().catch(() => {});
  }
  async pause(id) {
    const w = this.find(id); this.generation++;
    await this.stopRunner();
    await this.persist(w, 'paused', '工作流已暂停；继续前请核对已执行的操作。');
  }
  async remove(id) {
    const w = this.find(id); if (ACTIVE.has(w.status)) throw new Error('请先暂停工作流。');
    this.service.data.workflows = this.all.filter(x => x !== w); await this.service.vault.save(); this.service.publish();
  }
  async tick() {
    if (this.busy || this.service.stopping) return;
    const w = this.active; if (!w || !['monitoring', 'waiting'].includes(w.status)) return;
    this.busy = true; const generation = this.generation;
    try {
      await this.service.syncAll();
      if (generation !== this.generation) return;
      if (w.status === 'monitoring') {
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
      if (generation === this.generation) { await this.stopRunner(); await this.persist(w, 'needs_attention', safeError(error)); }
    } finally { this.busy = false; }
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
    if (await s.platform.desktopRunning(exe)) await s.platform.closeDesktop(exe);
    if (generation !== this.generation) return;
    s.data.settings.desktopPath = exe;
    await s.switchAccount(account.id, false, w.id);
    if (generation !== this.generation) return;
    if (w.accountId && w.accountId !== account.id) w.switchCount++;
    w.accountId = account.id;
    const rpc = new s.Rpc(s.data.settings.cliPath, w.home);
    const runner = { rpc, workflowId: w.id, generation, approval: null, completed: [], ready: false };
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
    if (msg.method === 'item/agentMessage/delta') {
      w.output = safeError(new Error(`${w.output}${String(p.delta ?? '')}`)).slice(-500);
      this.service.publish();
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
      this.cooldown(w, s.find(w.accountId));
      s.event(`工作流「${w.name}」额度耗尽，保留会话 ${w.threadId} 并准备切号`);
      await this.persist(w, 'waiting', '当前账号额度耗尽，正在选择下一个可用账号。');
      // tick's lock may still cover turn/start's response; the periodic tick also retries.
      queueMicrotask(() => this.tick().catch(() => {}));
    } else {
      await this.persist(w, turn.status === 'completed' ? 'completed' : 'needs_attention', turn.status === 'completed' ? '本轮任务已完成。会话历史已保存在原 CODEX_HOME。' : `任务停止：${safeError(turn.error?.message || turn.status)}，未触发自动切号。`);
      if (s.data.settings.desktopPath) await s.platform.launchDesktop(s.data.settings.desktopPath).catch(() => {});
    }
  }
  request(runner, msg) {
    if (this.runner !== runner) return;
    const w = this.find(runner.workflowId);
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
      const decisions = msg.params?.availableDecisions;
      const accept = !decisions || decisions.includes('accept');
      runner.approval = { requestId: msg.id, method: msg.method, command: safeError(msg.params?.command || msg.params?.reason || '请求写入文件'), cwd: msg.params?.cwd || w.cwd, canAccept: accept };
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
    const w = this.find(r.workflowId);
    if (interrupt && w.turnId && !r.finishing) await r.rpc.call('turn/interrupt', { threadId: w.threadId, turnId: w.turnId }, 5000).catch(() => {});
    await r.rpc.close(); this.service.sessions.delete(r.rpc);
  }
  async dispose() {
    clearInterval(this.timer); this.generation++;
    const w = this.active;
    await this.stopRunner();
    if (w && IN_FLIGHT.has(w.status)) await this.persist(w, 'needs_attention', '应用已退出，执行已中断；请核对项目后手动继续。');
  }
}
