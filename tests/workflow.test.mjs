import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../electron/service.mjs';
import { quotaState, quotaError, selectAutomaticTarget, pendingExecution } from '../electron/workflow.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('condition timed out'); }
const threadId = '01a15651-9fa2-7291-a6ff-b9def0813806';
async function setup(t, status = 'interrupted') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-workflow-'));
  const home = path.join(root, 'target'); await mkdir(home);
  const exe = path.join(root, 'fixture.exe'); await writeFile(exe, 'test');
  const thread = { id: threadId, cwd: home, originator: 'Codex Desktop', name: 'Original task', updatedAt: Math.floor(Date.now() / 1000) };
  class Rpc extends EventEmitter {
    static instances = []; static turn = { id: 'old-turn', status, startedAt: Math.floor(Date.now() / 1000), items: [] };
    static queue = []; static legacy = false; static offline = false; static unreadableSibling = false;
    constructor(_exe, _home, options) { super(); this.calls = []; this.options = options; Rpc.instances.push(this); }
    async initialize() {}
    async close() { this.closed = true; }
    async call(method, params) {
      this.calls.push({ method, params });
      if (Rpc.offline) throw new Error('fixture temporary connection failure');
      if (['thread/resume', 'turn/start', 'thread/start', 'thread/queue/start'].includes(method)) throw new Error('Account Deck must NEVER execute a task');
      if (method === 'thread/read') return { thread: { ...thread, turns: [Rpc.turn] } };
      if (method === 'thread/list') return { data: Rpc.unreadableSibling ? [{ ...thread, id: 'broken-sibling' }, thread] : [thread] };
      if (method === 'thread/turns/list') {
        if (params.threadId === 'broken-sibling') throw new Error('fixture invalid rollout');
        if (Rpc.legacy) throw new Error('list_turns is not supported yet');
        return { data: [Rpc.turn] };
      }
      if (method === 'thread/queue/list') return { data: Rpc.queue };
      if (method === 'thread/queue/add') { const queuedSubmission = { ...params, id: 'queued-fixture' }; Rpc.queue.push(queuedSubmission); return { queuedSubmission }; }
      return {};
    }
  }
  const platform = { running: true, log: [], desktopRunning: async () => platform.running,
    closeDesktop: async () => { platform.log.push('close'); platform.running = false; },
    launchDesktop: async (exe, options) => { platform.log.push({ launch: exe, ...options }); platform.running = true; } };
  const service = new AccountService({ directory: path.join(root, 'data'), crypto: testCrypto(), defaults: { cliPath: exe, desktopPath: exe, codexHome: home, autoSync: false, pollSeconds: 3600, lowResource: true }, Rpc, platform });
  await service.init();
  const a = await service.importFile(fixtureAuth('first')), b = await service.importFile(fixtureAuth('second'));
  function quota(id, remaining) { const a = service.find(id); a.error = null; a.syncedAt = Date.now(); a.limits = [{ id: 'codex', windows: [{ remaining, resetsAt: Math.floor(Date.now() / 1000) + 120, key: 'primary', minutes: 300 }] }]; }
  quota(a, 70); quota(b, 90);
  await writeFile(path.join(home, 'auth.json'), JSON.stringify(service.find(a).auth));
  service.syncAll = async ids => { (service.syncRequests ??= []).push(ids); };
  const id = await service.workflow.create({ name: 'workflow', mode: 'auto', cwd: '', accountIds: [a, b] });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, engine: service.workflow, w: service.workflow.find(id), a, b, Rpc, platform, home, quota, thread };
}
async function start({ engine, w }) { await engine.start(w.id); await until(() => !engine.busy); }
function executedCalls(Rpc) { return Rpc.instances.flatMap(r => r.calls).filter(c => ['thread/resume', 'turn/start', 'thread/start', 'thread/queue/start'].includes(c.method)); }

test('quota errors accept subscription signals but reject generic 429, policy and unknown quotas', () => {
  assert.equal(quotaError({ codexErrorInfo: 'rateLimitExceeded' }), true);
  assert.equal(quotaError({ codexErrorInfo: { usageLimitExceeded: {} } }), true);
  assert.equal(quotaError({ message: "You've hit your usage limit. Try again later." }), true);
  assert.equal(quotaError({ message: '429 too many requests' }), false);
  assert.equal(quotaError({ codexErrorInfo: 'contextWindowExceeded' }), false);
  assert.equal(quotaState({ error: null, syncedAt: Date.now(), limits: [{ id: 'codex', windows: [{ remaining: null }] }] }, 'codex'), 'unknown');
});

test('interrupted work is queued once and immediately reopened in OFFICIAL desktop, never executed by Account Deck', async t => {
  const x = await setup(t); await start(x);
  assert.equal(x.w.status, 'running'); assert.equal(x.w.threadId, threadId); assert.equal(x.w.cwd, x.home);
  assert.equal(x.Rpc.queue.length, 1); assert.match(x.Rpc.queue[0].input[0].text, /不要重复/);
  assert.equal(x.platform.log[0], 'close'); assert.equal(x.platform.log[1].threadId, threadId);
  assert.equal(x.platform.log[1].home, x.home); assert.equal(x.platform.running, true);
  assert.deepEqual(executedCalls(x.Rpc), []);
  assert.ok(x.Rpc.instances.every(r => r.options.ephemeral && r.closed));
  assert.ok(x.engine.timer); assert.equal(x.engine.timer._idleTimeout, 15000);
  await x.engine.tick(); assert.equal(x.Rpc.queue.length, 1);
});

test('background TIMER detects exhausted account, switches and restarts official desktop without a manual click', async t => {
  const x = await setup(t, 'inProgress'); await start(x);
  assert.equal(x.w.status, 'monitoring'); assert.equal(x.platform.log.length, 0);
  x.quota(x.a, 0);
  // Execute the installed background timer callback, with no workflowStart or restart action.
  x.engine.timer._onTimeout();
  await until(() => x.w.status === 'running' && !x.engine.busy);
  assert.equal(x.w.accountId, x.b); assert.equal(x.w.switchCount, 1);
  assert.equal(x.platform.log.at(-1).threadId, threadId); assert.ok(x.w.cooldowns[x.a] > Date.now());
  assert.deepEqual(executedCalls(x.Rpc), []);
});

test('explicit quota failure switches even if the last successful quota query still shows availability', async t => {
  const x = await setup(t, 'failed'); x.Rpc.turn.error = { codexErrorInfo: 'usageLimitExceeded' };
  await start(x); assert.equal(x.w.accountId, x.b); assert.equal(x.w.status, 'running');
});

test('legacy thread read fallback keeps monitoring and automatically handles its quota failure', async t => {
  const x = await setup(t, 'failed'); x.Rpc.legacy = true; x.Rpc.turn.error = { codexErrorInfo: 'rateLimitExceeded' };
  await start(x); assert.equal(x.w.status, 'running'); assert.equal(x.w.accountId, x.b);
  assert.ok(x.Rpc.instances.some(r => r.calls.some(c => c.method === 'thread/read' && c.params.includeTurns)));
});

test('transient monitoring errors retain the background timer and recover without pressing restart', async t => {
  const x = await setup(t, 'inProgress'); x.Rpc.offline = true; await start(x);
  assert.equal(x.w.status, 'monitoring'); assert.ok(x.engine.timer); assert.match(x.w.message, /自动重试/);
  x.Rpc.offline = false; x.w.retryAfter = 0; x.quota(x.a, 0);
  x.engine.timer._onTimeout(); await until(() => x.w.status === 'running' && !x.engine.busy);
  assert.equal(x.w.accountId, x.b);
});

test('an unreadable sibling does not disable monitoring healthy threads', async t => {
  const x = await setup(t); x.Rpc.unreadableSibling = true; await start(x);
  assert.equal(x.w.status, 'running'); assert.equal(x.w.threadId, threadId);
});

test('current-account quota polling ignores a one-hour dashboard sync interval', async t => {
  const x = await setup(t, 'inProgress'); x.service.find(x.a).syncedAt = Date.now() - 16000;
  await start(x); assert.deepEqual(x.service.syncRequests[0], [x.a]);
});

test('all accounts exhausted waits with official desktop open, then rotates when quota returns', async t => {
  const x = await setup(t); x.quota(x.a, 0); x.quota(x.b, 0); await start(x);
  assert.equal(x.w.status, 'waiting'); assert.equal(x.platform.log.length, 0); assert.ok(x.engine.timer);
  x.quota(x.b, 80); await x.engine.tick(); assert.equal(x.w.status, 'running'); assert.equal(x.w.accountId, x.b);
});

test('existing mode also detects zero quota during a live task instead of requiring a terminal quota error', async t => {
  const x = await setup(t, 'inProgress'); x.w.mode = 'existing'; x.w.threadId = threadId; x.w.cwd = x.home;
  x.quota(x.a, 0); await start(x); assert.equal(x.w.status, 'running'); assert.equal(x.w.accountId, x.b);
});

test('active tools are allowed to finish before restarting official desktop', async t => {
  const x = await setup(t, 'inProgress'); x.quota(x.a, 0); x.Rpc.turn.items = [{ type: 'commandExecution', status: 'inProgress' }];
  await start(x); assert.equal(x.w.status, 'monitoring'); assert.equal(x.platform.log.length, 0);
  x.Rpc.turn.items = []; await x.engine.tick(); assert.equal(x.w.status, 'running');
});

test('completion after selection never submits a duplicate continuation', async t => {
  const x = await setup(t); const original = x.engine.automaticTarget.bind(x.engine);
  x.engine.automaticTarget = async w => { const selected = await original(w); x.Rpc.turn = { ...x.Rpc.turn, status: 'completed' }; return selected; };
  await start(x); assert.equal(x.w.status, 'monitoring'); assert.equal(x.Rpc.queue.length, 0); assert.equal(x.platform.log.length, 0);
});

test('desktop completion returns automatic mode to monitoring and preserves official desktop running', async t => {
  const x = await setup(t); await start(x); x.Rpc.queue = [];
  x.Rpc.turn = { id: 'desktop-next-turn', status: 'completed', items: [] };
  await x.engine.tick(); assert.equal(x.w.status, 'monitoring'); assert.equal(x.w.completedCount, 1);
  assert.equal(x.w.threadId, null); assert.equal(x.platform.running, true);
});

test('later quota failure inside official desktop triggers another automatic rotation', async t => {
  const x = await setup(t); await start(x); x.Rpc.queue = [];
  x.Rpc.turn = { id: 'desktop-next-turn', status: 'failed', items: [], error: { codexErrorInfo: 'usageLimitExceeded' } };
  await x.engine.tick(); assert.equal(x.w.accountId, x.b); assert.equal(x.w.switchCount, 1);
  assert.equal(x.platform.log.filter(x => x === 'close').length, 2); assert.deepEqual(executedCalls(x.Rpc), []);
});

test('pause or quit only stops monitoring, leaving official desktop task untouched', async t => {
  const x = await setup(t); await start(x); const logCount = x.platform.log.length;
  await x.engine.pause(x.w.id); assert.equal(x.w.status, 'paused'); assert.equal(x.engine.timer, null);
  assert.equal(x.platform.log.length, logCount); assert.equal(x.platform.running, true); assert.deepEqual(executedCalls(x.Rpc), []);
});

test('persisted desktop queue resumes observation after restart without enqueuing again', async t => {
  const x = await setup(t); await start(x); const dispatch = x.w.dispatchId;
  await x.engine.recover(); assert.equal(x.w.status, 'running'); assert.equal(x.w.dispatchId, dispatch);
  await x.engine.tick(); assert.equal(x.Rpc.queue.length, 1);
});

test('existing user follow-up is woken without appending another continue instruction', async t => {
  const x = await setup(t); x.Rpc.queue = [{ id: 'user-queued', clientUserMessageId: 'user-message', input: [] }];
  await start(x); assert.equal(x.w.dispatchId, 'user-message'); assert.equal(x.Rpc.queue.length, 1);
});

test('new tasks must be created in official desktop; independent CLI tasks are observed until interrupted', async t => {
  const x = await setup(t, 'inProgress');
  await assert.rejects(() => x.engine.create({ name: 'no local runner', mode: 'new', accountIds: [x.a] }), /官方客户端/);
  x.thread.originator = 'codex_cli_rs'; x.quota(x.a, 0); await start(x);
  assert.equal(x.w.status, 'monitoring'); assert.equal(x.platform.log.length, 0);
});

test('automatic target prioritizes active tasks, filters old, completed, handled and out-of-scope work', () => {
  const cwd = path.resolve('project'), now = Math.floor(Date.now() / 1000);
  const entry = (id, status, time) => ({ thread: { id, cwd, updatedAt: time }, turn: { id: id + '-turn', status, startedAt: time } });
  const items = [entry('completed', 'completed', now), entry('interrupted', 'interrupted', now - 1), entry('active', 'inProgress', now - 10)];
  assert.equal(selectAutomaticTarget(items).thread.id, 'active');
  assert.equal(selectAutomaticTarget(items.slice(0, 2)).thread.id, 'interrupted');
  assert.equal(selectAutomaticTarget([items[0]]), null);
  assert.equal(selectAutomaticTarget([items[1]], { after: now * 1000 }), null);
  assert.equal(selectAutomaticTarget([items[1]], { scope: path.resolve('other') }), null);
  assert.equal(selectAutomaticTarget([items[1]], { handled: ['interrupted:interrupted-turn'] }), null);
  assert.equal(pendingExecution({}, { status: { activeFlags: ['waitingOnApproval'] } }), true);
});

test('legacy workflows stopped by compatibility errors migrate to active desktop monitoring; user-paused workflows stay paused', async t => {
  const x = await setup(t, 'inProgress'); x.w.executor = undefined; x.w.status = 'needs_attention';
  await x.engine.recover(); assert.equal(x.w.status, 'monitoring'); assert.equal(x.w.executor, 'desktop');
  x.w.executor = undefined; x.w.status = 'paused'; await x.engine.recover(); assert.equal(x.w.status, 'paused');
});

test('pausing during queue storage cannot reactivate the monitor after an asynchronous handoff', async t => {
  const x = await setup(t); const history = x.engine.withHistory.bind(x.engine); let count = 0;
  x.engine.withHistory = async operation => history(async rpc => {
    const original = rpc.call.bind(rpc);
    rpc.call = async (method, params) => { const value = await original(method, params); if (method === 'thread/queue/add' && count++ === 0) await x.engine.pause(x.w.id); return value; };
    return operation(rpc);
  });
  await start(x); assert.equal(x.w.status, 'paused'); assert.equal(x.engine.timer, null);
});
