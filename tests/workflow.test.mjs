import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../electron/service.mjs';
import { quotaState, quotaError } from '../electron/workflow.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('condition timed out'); }
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-workflow-'));
  const home = path.join(root, 'target'); await mkdir(home);
  const exe = path.join(root, 'fixture.exe'); await writeFile(exe, 'test');
  class Rpc extends EventEmitter {
    static instances = []; static last = { id: 'old-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } };
    static dispatchFails = false;
    constructor() { super(); this.calls = []; this.sent = []; Rpc.instances.push(this); }
    async initialize() {}
    async close() { this.closed = true; this.emit('closed'); }
    send(msg) { this.sent.push(msg); }
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'original-thread', cwd: home } };
      if (method === 'thread/turns/list') return { data: [Rpc.last] };
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
