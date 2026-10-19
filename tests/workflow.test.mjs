import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../electron/service.mjs';
import { quotaState, quotaError, selectAutomaticTarget, pendingExecution } from '../electron/workflow.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('condition timed out'); }
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-workflow-'));
  const home = path.join(root, 'target'); await mkdir(home);
  const exe = path.join(root, 'fixture.exe'); await writeFile(exe, 'test');
  class Rpc extends EventEmitter {
    static instances = []; static last = { id: 'old-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } };
    static dispatchFails = false; static inventory = []; static turns = new Map(); static lookups = 0;
    constructor() { super(); this.calls = []; this.sent = []; Rpc.instances.push(this); }
    async initialize() {}
    async close() { this.closed = true; this.emit('closed'); }
    send(msg) { this.sent.push(msg); }
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'original-thread', cwd: home } };
      if (method === 'thread/list') return { data: Rpc.inventory };
      if (method === 'thread/turns/list') { Rpc.lookups++; return { data: [Rpc.turns.get(params.threadId) || Rpc.last] }; }
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'thread/start') return { thread: { id: 'new-thread' } };
      if (method === 'turn/start') { if (Rpc.dispatchFails) throw new Error('transport timeout'); return { turn: { id: `turn-${Rpc.instances.length}`, status: 'inProgress' } }; }
      return {};
    }
  }
  const platform = { desktopRunning: async () => false, closeDesktop: async () => {}, launchDesktop: async () => { platform.launches++; }, launches: 0 };
  const service = new AccountService({ directory: path.join(root, 'data'), crypto: testCrypto(), defaults: { cliPath: exe, desktopPath: exe, codexHome: home, autoSync: false, pollSeconds: 60 }, Rpc, platform });
  await service.init(); clearInterval(service.workflow.timer);
  const a = await service.importFile(fixtureAuth('first')), b = await service.importFile(fixtureAuth('second'));
  function quota(id, remaining) { const a = service.find(id); a.error = null; a.syncedAt = Date.now(); a.limits = [{ id: 'codex', windows: [{ remaining, resetsAt: Math.floor(Date.now() / 1000) + 120, key: 'primary', minutes: 300 }] }]; }
  quota(a, 70); quota(b, 90);
  await writeFile(path.join(home, 'auth.json'), JSON.stringify(service.find(a).auth));
  service.syncAll = async () => {};
  const id = await service.workflow.create({ name: 'workflow', mode: 'new', cwd: home, prompt: 'Implement fixture task', accountIds: [a, b] });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, engine: service.workflow, w: service.workflow.find(id), a, b, Rpc, platform, home, quota };
}
test('quota selection rejects unknown, stale and failed data; generic 429 is not subscription exhaustion', () => {
  assert.equal(quotaError({ codexErrorInfo: 'rateLimitExceeded' }), true);
  assert.equal(quotaError({ message: '429 too many requests' }), false);
  assert.equal(quotaError({ codexErrorInfo: 'contextWindowExceeded' }), false);
  assert.equal(quotaState({ error: null, syncedAt: Date.now(), limits: [{ id: 'codex', windows: [{ remaining: null }] }] }, 'codex'), 'unknown');
  assert.equal(quotaState({ error: null, syncedAt: Date.now() - 200000, limits: [{ id: 'codex', windows: [{ remaining: 100 }] }] }, 'codex'), 'unknown');
});
test('quota failure rotates account and resumes SAME thread, cwd and remaining task; duplicate terminal event ignored', async t => {
  const { engine, w, a, b, service, Rpc, platform } = await setup(t);
  await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  const first = engine.runner.rpc;
  assert.equal(w.accountId, a); assert.equal(w.threadId, 'new-thread');
  const failure = { method: 'turn/completed', params: { threadId: w.threadId, turn: { id: w.turnId, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } } };
  first.emit('notification', failure); first.emit('notification', failure);
  await until(() => w.status === 'running' && w.accountId === b && !engine.busy);
  const second = engine.runner.rpc;
  const resume = second.calls.find(x => x.method === 'thread/resume'); assert.equal(resume.params.threadId, 'new-thread'); assert.equal(resume.params.cwd, w.cwd);
  assert.match(second.calls.find(x => x.method === 'turn/start').params.input[0].text, /不要重复/);
  assert.equal(w.switchCount, 1); assert.equal(first.closed, true);
  assert.equal(Rpc.instances.filter(x => x.calls.some(c => c.method === 'turn/start')).length, 2);
  await assert.rejects(() => service.switchAccount(a), /工作流/);
  second.emit('notification', { method: 'turn/completed', params: { threadId: w.threadId, turn: { id: w.turnId, status: 'completed' } } });
  await until(() => w.status === 'completed'); assert.equal(platform.launches, 1);
});
test('all accounts exhausted waits without submitting work, automatically continues after quota reset', async t => {
  const { engine, w, a, b, quota } = await setup(t); quota(a, 0); quota(b, 0);
  await engine.start(w.id); await until(() => !engine.busy);
  assert.equal(w.status, 'waiting'); assert.equal(w.threadId, null);
  quota(b, 95); await engine.tick(); assert.equal(w.status, 'running'); assert.equal(w.accountId, b);
});
test('non-quota failure and ambiguous dispatch never auto-rotate or replay after restart', async t => {
  const { engine, w, Rpc } = await setup(t); Rpc.dispatchFails = true;
  await engine.start(w.id); await until(() => w.status === 'needs_attention');
  const count = Rpc.instances.length; await engine.tick(); assert.equal(Rpc.instances.length, count);
  w.status = 'running'; await engine.recover(); assert.equal(w.status, 'needs_attention');
});
test('approval is exposed, requires matching request and is never auto-accepted', async t => {
  const { engine, w } = await setup(t); await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  const rpc = engine.runner.rpc;
  rpc.emit('request', { id: 77, method: 'item/commandExecution/requestApproval', params: { command: 'fixture command', availableDecisions: ['accept', 'decline'] } });
  await until(() => w.status === 'approval'); assert.equal(rpc.sent.length, 0); assert.equal(engine.snapshot()[0].approval.requestId, 77);
  await assert.rejects(() => engine.approve(w.id, 78, true), /过期/);
  await engine.approve(w.id, 77, false); assert.equal(rpc.sent[0].result.decision, 'decline');
  await engine.pause(w.id); assert.equal(w.status, 'paused'); assert.equal(rpc.closed, true);
});
test('monitor only takes over an explicitly quota-failed turn, preserving original thread', async t => {
  const { engine, w, a, b, Rpc } = await setup(t); w.mode = 'existing'; w.threadId = 'original-thread';
  Rpc.last = { id: 'running-turn', status: 'inProgress' };
  await engine.start(w.id); await until(() => !engine.busy); assert.equal(w.status, 'monitoring');
  Rpc.last = { id: 'failed-turn', status: 'failed', error: { codexErrorInfo: 'contextWindowExceeded' } };
  await engine.tick(); assert.equal(w.status, 'monitoring');
  Rpc.last = { id: 'failed-turn', status: 'failed', error: { codexErrorInfo: 'rateLimitExceeded' } };
  await engine.tick(); assert.equal(w.status, 'running'); assert.equal(w.threadId, 'original-thread'); assert.equal(w.accountId, b);
  assert.ok(w.cooldowns[a] > Date.now());
});
test('unsupported host tool pauses instead of fabricating execution result', async t => {
  const { engine, w } = await setup(t); await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  const rpc = engine.runner.rpc;
  rpc.emit('request', { id: 88, method: 'item/tool/call', params: {} });
  await until(() => w.status === 'needs_attention'); assert.equal(rpc.sent[0].error.code, -32601); assert.equal(engine.runner, null);
});
test('idle and executing workflows have no polling timer; incomplete approval preview cannot be accepted', async t => {
  const { engine, w } = await setup(t); engine.schedule(); assert.ok(!engine.timer);
  await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  engine.schedule(); assert.ok(!engine.timer || engine.timer._destroyed);
  engine.runner.rpc.emit('request', { id: 99, method: 'item/fileChange/requestApproval', params: { itemId: 'unknown' } });
  await until(() => w.status === 'approval');
  assert.equal(engine.snapshot()[0].approval.canAccept, false);
  await assert.rejects(() => engine.approve(w.id, 99, true), /未提供/);
});
function entry(id, cwd, status, time, error = null) {
  return { thread: { id, cwd, name: id, updatedAt: time, originator: 'Codex Desktop' }, turn: { id: `${id}-turn`, status, startedAt: time, completedAt: status === 'inProgress' ? null : time, error, items: [] } };
}
test('automatic target prioritizes activity, then the most recent interruption; excludes completed, old and out-of-scope work', () => {
  const cwd = path.resolve('project'), now = Math.floor(Date.now() / 1000);
  const items = [entry('completed', cwd, 'completed', now), entry('recent-paused', cwd, 'interrupted', now - 1), entry('active', cwd, 'inProgress', now - 10)];
  assert.equal(selectAutomaticTarget(items).thread.id, 'active');
  assert.equal(selectAutomaticTarget(items.slice(0, 2)).thread.id, 'recent-paused');
  assert.equal(selectAutomaticTarget([items[0]]), null);
  assert.equal(selectAutomaticTarget([items[1]], { after: now * 1000 }), null);
  assert.equal(selectAutomaticTarget([items[1]], { scope: path.resolve('another-project') }), null);
  assert.equal(selectAutomaticTarget([items[1]], { handled: ['recent-paused:recent-paused-turn'] }), null);
  const old = entry('old', cwd, 'interrupted', now - 100000); old.thread.updatedAt = now;
  assert.equal(selectAutomaticTarget([old], { after: (now - 86400) * 1000 }), null);
  assert.equal(pendingExecution({ items: [{ type: 'commandExecution', status: 'inProgress' }] }), true);
  assert.equal(pendingExecution({}, { status: { activeFlags: ['waitingOnApproval'] } }), true);
});
async function autoSetup(t, status = 'interrupted') {
  const setupResult = await setup(t); const { engine, w, home, Rpc } = setupResult;
  const item = entry('auto-original', home, status, Math.floor(Date.now() / 1000) - 10, status === 'failed' ? { codexErrorInfo: 'usageLimitExceeded' } : null);
  Rpc.inventory = [item.thread]; Rpc.turns.set(item.thread.id, item.turn);
  await engine.remove(w.id);
  const id = await engine.create({ name: 'automatic', mode: 'auto', accountIds: [setupResult.a, setupResult.b], cwd: '' });
  return { ...setupResult, w: engine.find(id), item };
}
test('without an active task automatic mode resumes the latest interrupted work without a manually selected thread', async t => {
  const { engine, w, item, a } = await autoSetup(t);
  await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  assert.equal(w.threadId, item.thread.id); assert.equal(w.cwd, item.thread.cwd); assert.equal(w.accountId, a);
  const rpc = engine.runner.rpc;
  assert.equal(rpc.calls.find(x => x.method === 'thread/resume').params.threadId, item.thread.id);
  assert.match(rpc.calls.find(x => x.method === 'turn/start').params.input[0].text, /中断且尚未完成/);
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: w.threadId, turn: { id: w.turnId, status: 'completed' } } });
  await until(() => w.status === 'monitoring'); assert.equal(w.completedCount, 1); assert.equal(w.threadId, null);
  assert.ok(w.handledTurns.includes(`${item.thread.id}:${item.turn.id}`));
});
test('active task is followed until quota is exhausted, then switches and resumes its original thread', async t => {
  const { engine, w, a, b, quota, item, Rpc } = await autoSetup(t, 'inProgress');
  await engine.start(w.id); await until(() => !engine.busy); assert.equal(w.status, 'monitoring'); assert.equal(engine.runner, null);
  assert.equal(w.observedTarget.threadId, item.thread.id);
  quota(a, 0); engine.turnCache.clear(); await engine.tick();
  assert.equal(w.status, 'running'); assert.equal(w.accountId, b); assert.equal(w.threadId, item.thread.id); assert.equal(w.switchCount, 1);
  assert.ok(Rpc.instances.some(r => r.calls.some(c => c.method === 'thread/resume' && c.params.threadId === item.thread.id)));
});
test('automatic takeover waits for a running tool and does not pick an older interrupted task instead', async t => {
  const { engine, w, a, quota, item } = await autoSetup(t, 'inProgress');
  quota(a, 0); item.turn.items = [{ type: 'commandExecution', status: 'inProgress' }];
  await engine.start(w.id); await until(() => !engine.busy);
  assert.equal(w.status, 'monitoring'); assert.equal(engine.runner, null); assert.match(w.message, /工具/);
});
test('completed-after-selection race does not send another continue request', async t => {
  const { engine, w, item, Rpc } = await autoSetup(t);
  const original = engine.automaticTarget.bind(engine);
  engine.automaticTarget = async target => { const result = await original(target); Rpc.turns.set(item.thread.id, { ...item.turn, status: 'completed' }); return result; };
  await engine.start(w.id); await until(() => !engine.busy);
  assert.equal(w.status, 'monitoring'); assert.equal(engine.runner, null);
  assert.equal(Rpc.instances.filter(r => r.calls.some(c => c.method === 'turn/start')).length, 0);
});
test('automatic selection reuses unchanged turn metadata and skips completed conversations', async t => {
  const { engine, w, item, Rpc } = await autoSetup(t, 'completed');
  assert.equal(await engine.automaticTarget(w), null);
  const lookups = Rpc.lookups; assert.equal(await engine.automaticTarget(w), null); assert.equal(Rpc.lookups, lookups);
  assert.equal(item.turn.status, 'completed');
});
test('an independent CLI active turn is never duplicated by automatic desktop takeover', async t => {
  const { engine, w, a, quota, item } = await autoSetup(t, 'inProgress');
  quota(a, 0); item.thread.originator = 'codex_cli_rs';
  await engine.start(w.id); await until(() => !engine.busy);
  assert.equal(w.status, 'monitoring'); assert.equal(engine.runner, null); assert.match(w.message, /独立 CLI/);
});
test('automatic continuation recovers a transient stream interruption but excludes authentication and policy failures', () => {
  const cwd = path.resolve('project'), now = Math.floor(Date.now() / 1000);
  const interrupted = entry('stream-failed', cwd, 'failed', now, { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } });
  assert.equal(selectAutomaticTarget([interrupted]).thread.id, 'stream-failed');
  for (const kind of ['unauthorized', 'contextWindowExceeded', 'cyberPolicy', 'sandboxError']) {
    interrupted.turn.error = { codexErrorInfo: kind }; assert.equal(selectAutomaticTarget([interrupted]), null);
  }
});
test('automatic worker retries an actual interruption with a delay instead of stopping the workflow', async t => {
  const { engine, w, Rpc, item } = await autoSetup(t);
  await engine.start(w.id); await until(() => w.status === 'running' && !engine.busy);
  const interruptedTurn = { id: w.turnId, status: 'interrupted', items: [] };
  Rpc.turns.set(item.thread.id, interruptedTurn);
  engine.runner.rpc.emit('notification', { method: 'turn/completed', params: { threadId: w.threadId, turn: interruptedTurn } });
  await until(() => w.status === 'waiting'); assert.equal(w.recoveryAttempts, 1); assert.ok(w.retryAfter > Date.now());
  w.retryAfter = 0; await engine.tick(); assert.equal(w.status, 'running'); assert.equal(w.threadId, item.thread.id);
});
