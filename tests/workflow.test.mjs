import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../electron/service.mjs';
import { quotaError, quotaState, nextAccount, observedEntry } from '../electron/workflow.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';
const id = '01a15651-9fa2-7291-a6ff-b9def0813806';
const otherId = '01a15651-9fa2-7291-a6ff-b9def0813807';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error('condition timed out'); }
async function setup(t, status = 'interrupted') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-monitor-')), home = path.join(root, 'target'); await mkdir(home);
  const exe = path.join(root, 'client.exe'); await writeFile(exe, 'fixture');
  const thread = { id, cwd: home, originator: 'Codex Desktop', name: 'Original project task', updatedAt: Math.floor(Date.now() / 1000) };
  class Rpc extends EventEmitter {
    static calls = []; static queue = []; static legacy = false; static offline = false;
    static threads = [thread]; static turn = { id: 'original-turn', status, startedAt: Math.floor(Date.now() / 1000) - 10, completedAt: null, items: [] };
    static otherTurn = { id: 'other-turn', status: 'interrupted', startedAt: Math.floor(Date.now() / 1000) - 60, completedAt: null, items: [] };
    constructor(_exe, _home, options) { super(); assert.equal(options.ephemeral, true); }
    async initialize() {}
    async close() {}
    async call(method, params) {
      Rpc.calls.push({ method, params }); if (Rpc.offline) throw new Error('temporary connection failure');
      if (['thread/resume', 'thread/start', 'turn/start', 'thread/queue/start'].includes(method)) throw new Error('Forbidden independent task execution');
      if (method === 'thread/list') return { data: Rpc.threads };
      if (method === 'thread/read') return { thread: { ...(Rpc.threads.find(t => t.id === params.threadId) || thread), turns: [params.threadId === otherId ? Rpc.otherTurn : Rpc.turn] } };
      if (method === 'thread/turns/list') { if (Rpc.legacy) throw new Error('list_turns is not supported yet'); return { data: [params.threadId === otherId ? Rpc.otherTurn : Rpc.turn] }; }
      if (method === 'thread/queue/list') return { data: Rpc.queue };
      if (method === 'thread/queue/add') { const queuedSubmission = { ...params, id: 'queued-id' }; Rpc.queue.push(queuedSubmission); return { queuedSubmission }; }
      if (method === 'thread/queue/delete') { Rpc.queue = Rpc.queue.filter(q => q.id !== params.queuedSubmissionId); return {}; }
      return {};
    }
  }
  const platform = { held: [], unknown: false, log: [], running: true,
    threadWriters: async () => ({ busy: [...platform.held], unknown: platform.unknown }),
    desktopRunning: async () => platform.running,
    closeDesktop: async () => { platform.log.push('close'); platform.running = false; },
    launchDesktop: async (_exe, options) => { platform.log.push({ launch: true, ...options }); platform.running = true; } };
  const service = new AccountService({ directory: path.join(root, 'data'), crypto: testCrypto(), defaults: { cliPath: exe, desktopPath: exe, codexHome: home, autoSync: false, pollSeconds: 3600, lowResource: true }, Rpc, platform });
  await service.init();
  const a = await service.importFile(fixtureAuth('first')), b = await service.importFile(fixtureAuth('second'));
  function quota(accountId, remaining) { Object.assign(service.find(accountId), { error: null, syncedAt: Date.now(), limits: [{ id: 'codex', windows: [{ key: 'primary', remaining, resetsAt: Math.floor(Date.now() / 1000) + 120 }] }] }); }
  quota(a, 64); quota(b, 100); await writeFile(path.join(home, 'auth.json'), JSON.stringify(service.find(a).auth));
  service.syncAll = async ids => { (service.syncRequests ??= []).push(ids); };
  const workflowId = await service.workflow.create({ name: 'automatic', mode: 'auto', cwd: '', accountIds: [a, b] });
  const w = service.workflow.find(workflowId), engine = service.workflow;
  const originalSwitch = service.switchAccount.bind(service); service.switches = 0;
  service.switchAccount = async (...args) => { service.switches++; return originalSwitch(...args); };
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, engine, w, a, b, quota, Rpc, platform, thread, home };
}
async function start(x) { await x.engine.start(x.w.id); await until(() => !x.engine.busy); }
function completeOwn(x, status = 'completed') {
  x.Rpc.turn = { id: 'desktop-turn', status, startedAt: Math.floor(Date.now() / 1000), completedAt: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    items: [{ type: 'userMessage', id: 'server-generated-id', clientId: x.w.dispatchId, content: [] }] }; x.Rpc.queue = [];
}

test('actual snapshot regression: healthy running writer with history interrupted never switches, restarts or enqueues on repeated ticks', async t => {
  const x = await setup(t); x.platform.held = [id];
  const before = await readFile(path.join(x.home, 'auth.json'), 'utf8'); await start(x);
  for (let i = 0; i < 5; i++) await x.engine.tick();
  assert.equal(x.w.observedTarget.threadId, id); assert.equal(x.w.observedTarget.status, 'inProgress');
  assert.equal(x.w.status, 'monitoring'); assert.equal(x.service.switches, 0); assert.deepEqual(x.platform.log, []); assert.deepEqual(x.Rpc.queue, []);
  assert.equal(await readFile(path.join(x.home, 'auth.json'), 'utf8'), before);
});

test('live task is never preempted by a 0% quota snapshot', async t => {
  const x = await setup(t, 'inProgress'); x.quota(x.a, 0); await start(x);
  assert.equal(x.w.status, 'monitoring'); assert.equal(x.service.switches, 0); assert.deepEqual(x.platform.log, []);
});

test('ordinary interruption resumes original thread WITHOUT switching, auth writes or closing official desktop, even if another account is first', async t => {
  const x = await setup(t); x.w.accountIds = [x.b, x.a]; const before = await readFile(path.join(x.home, 'auth.json'), 'utf8'); await start(x);
  assert.equal(x.w.status, 'resuming'); assert.equal(x.w.accountId, x.a); assert.equal(x.service.switches, 0); assert.equal(x.platform.log.includes('close'), false);
  assert.equal(x.platform.log[0].threadId, id); assert.equal(x.platform.log[0].home, x.home); assert.equal(x.Rpc.queue.length, 1);
  assert.equal(await readFile(path.join(x.home, 'auth.json'), 'utf8'), before);
  for (let i = 0; i < 4; i++) await x.engine.tick();
  assert.equal(x.Rpc.queue.length, 1); assert.equal(x.platform.log.length, 1); assert.equal(x.w.status, 'resuming');
});

test('quota switch requires observed original turn failure AND fresh zero, selects a genuinely different account using background timer', async t => {
  const x = await setup(t, 'inProgress'); await start(x); x.quota(x.a, 0);
  x.Rpc.turn = { ...x.Rpc.turn, status: 'failed', completedAt: Math.floor(Date.now() / 1000), error: { codexErrorInfo: 'usageLimitExceeded' } };
  x.engine.timer._onTimeout(); await until(() => !x.engine.busy && x.w.status === 'resuming');
  assert.equal(x.w.accountId, x.b); assert.equal(x.w.switchCount, 1); assert.equal(x.service.switches, 1);
  assert.equal(x.platform.log[0], 'close'); assert.equal(x.platform.log[1].threadId, id);
});

test('historical quota error with healthy current account never switches or restarts', async t => {
  const x = await setup(t, 'inProgress'); await start(x);
  x.Rpc.turn = { ...x.Rpc.turn, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } };
  await x.engine.tick(); assert.equal(x.service.switches, 0); assert.deepEqual(x.platform.log, []); assert.match(x.w.message, /不符/);
});

test('unobserved quota failure from an older account cannot be attributed to the current account', async t => {
  const x = await setup(t, 'failed'); x.Rpc.turn.error = { codexErrorInfo: 'usageLimitExceeded' }; x.quota(x.a, 0); await start(x);
  assert.equal(x.service.switches, 0); assert.deepEqual(x.platform.log, []); assert.match(x.w.message, /尚未确认/);
});

test('same-account-only candidate pool waits without touching auth or restarting', async t => {
  const x = await setup(t, 'inProgress'); x.w.accountIds = [x.a]; await start(x); x.quota(x.a, 0);
  x.Rpc.turn = { ...x.Rpc.turn, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }; await x.engine.tick();
  assert.equal(x.w.status, 'waiting'); assert.equal(x.service.switches, 0); assert.deepEqual(x.platform.log, []);
  const duplicate = { ...x.service.find(x.a), id: 'different-record-same-identity' };
  assert.equal(nextAccount([duplicate], { accountIds: [duplicate.id], cooldowns: {} }, Date.now(), 60000, x.service.find(x.a)), undefined);
});

test('active task in another project prevents resuming an old interrupted task, including outside scope', async t => {
  const x = await setup(t); x.Rpc.threads.push({ ...x.thread, id: otherId, cwd: path.resolve(x.home, '..'), updatedAt: x.thread.updatedAt + 1 });
  x.platform.held = [otherId]; x.w.scope = x.home; await start(x);
  assert.deepEqual(x.platform.log, []); assert.equal(x.Rpc.queue.length, 0); assert.equal(x.service.switches, 0);
});

test('unknown ownership or a live writer makes interruption recovery fail closed', async t => {
  const x = await setup(t); x.platform.unknown = true; await start(x);
  assert.equal(x.w.status, 'monitoring'); assert.equal(x.Rpc.queue.length, 0); assert.deepEqual(x.platform.log, []);
});

test('restoration is acknowledged only by matching user message clientId in the SAME thread', async t => {
  const x = await setup(t); await start(x); assert.equal(x.w.status, 'resuming');
  completeOwn(x, 'inProgress'); x.platform.held = [id]; await x.engine.tick();
  assert.equal(x.w.status, 'running'); assert.equal(x.w.following, true); assert.equal(x.w.dispatchId, null);
  x.Rpc.turn.status = 'interrupted'; // Real persisted history while its writer is still running.
  await x.engine.tick(); await x.engine.tick();
  assert.equal(x.w.status, 'running'); assert.equal(x.service.switches, 0); assert.equal(x.platform.log.length, 1);
});

test('an unrelated new turn is not false proof of recovery and cancels only our own queued continuation', async t => {
  const x = await setup(t); await start(x);
  x.Rpc.queue.push({ id: 'user-followup', clientUserMessageId: 'user-owned-message', input: [] });
  x.Rpc.turn = { id: 'different-user-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: 'user-owned-message' }] };
  await x.engine.tick(); assert.equal(x.w.status, 'needs_attention'); assert.equal(x.w.following, false);
  assert.deepEqual(x.Rpc.queue.map(q => q.id), ['user-followup']); assert.equal(x.service.switches, 0);
});

test('completed acknowledgement releases the original task only once', async t => {
  const x = await setup(t); await start(x); completeOwn(x); await x.engine.tick();
  assert.equal(x.w.completedCount, 1); assert.equal(x.w.status, 'monitoring'); assert.equal(x.w.threadId, null);
  await x.engine.tick(); assert.equal(x.w.completedCount, 1); assert.equal(x.platform.log.length, 1);
});

test('failed wake verification stops without enqueuing again, switching again, or claiming a running task', async t => {
  const x = await setup(t); await start(x); x.w.dispatchAt = Date.now() - 100000; await x.engine.tick();
  assert.equal(x.w.status, 'needs_attention'); assert.equal(x.Rpc.queue.length, 1); assert.equal(x.service.switches, 0); assert.equal(x.platform.log.length, 1);
});

test('a resumed task interrupted again is not repeatedly restarted or submitted', async t => {
  const x = await setup(t); await start(x); completeOwn(x, 'interrupted'); await x.engine.tick();
  assert.equal(x.w.status, 'needs_attention'); assert.equal(x.service.switches, 0); assert.equal(x.platform.log.length, 1); assert.equal(x.Rpc.queue.length, 0);
});

test('legacy metadata reading and transient monitoring failures retain non-destructive background checks', async t => {
  const x = await setup(t); x.Rpc.legacy = true; x.platform.held = [id]; await start(x);
  assert.equal(x.w.observedTarget.status, 'inProgress'); assert.equal(x.platform.log.length, 0);
  x.Rpc.offline = true; await x.engine.tick(); assert.equal(x.w.status, 'monitoring'); assert.ok(x.engine.timer);
});

test('upgrade keeps old automation paused instead of silently re-enabling it', async t => {
  const x = await setup(t); x.w.policyVersion = undefined; x.w.status = 'monitoring'; x.w.dispatchId = 'stale'; await x.engine.recover();
  assert.equal(x.w.status, 'paused'); assert.equal(x.w.dispatchId, null); assert.equal(x.w.policyVersion, 2); assert.deepEqual(x.platform.log, []);
});

test('pause cancels only unsent automatic message and never stops the official client', async t => {
  const x = await setup(t); await start(x); x.Rpc.queue.push({ id: 'user-followup', clientUserMessageId: 'user-owned' });
  await x.engine.pause(x.w.id); assert.equal(x.w.status, 'paused'); assert.equal(x.engine.timer, null);
  assert.deepEqual(x.Rpc.queue.map(q => q.id), ['user-followup']); assert.equal(x.platform.running, true); assert.equal(x.platform.log.includes('close'), false);
});

test('no model or tool execution takes place in Account Deck', async t => {
  const x = await setup(t); await start(x);
  assert.equal(x.Rpc.calls.some(c => ['thread/start', 'thread/resume', 'turn/start', 'thread/queue/start'].includes(c.method)), false);
});

test('ownership normalization changes only unfinished interrupted history and preserves explicit terminal errors', () => {
  const thread = { id }, writers = { busy: [id] };
  assert.equal(observedEntry(thread, { status: 'interrupted', completedAt: null }, writers).turn.status, 'inProgress');
  assert.equal(observedEntry(thread, { status: 'interrupted', completedAt: 5 }, writers).turn.status, 'interrupted');
  assert.equal(observedEntry(thread, { status: 'failed', completedAt: null }, writers).turn.status, 'failed');
  assert.equal(quotaError({ message: '429 too many requests' }), false);
  assert.equal(quotaState({ limits: [], syncedAt: Date.now() }, 'codex'), 'unknown');
});

test('pausing during a slow quota refresh cannot reactivate the workflow', async t => {
  const x = await setup(t, 'inProgress'); x.service.find(x.a).syncedAt = 0;
  x.service.syncAll = async () => x.engine.pause(x.w.id);
  await start(x); assert.equal(x.w.status, 'paused'); assert.equal(x.engine.timer, null); assert.deepEqual(x.platform.log, []);
});

test('pausing before queue submission leaves no automatic message or implicit wake', async t => {
  const x = await setup(t); const base = x.engine.withHistory.bind(x.engine); let paused = false;
  x.engine.withHistory = operation => base(async rpc => {
    const call = rpc.call.bind(rpc);
    rpc.call = async (method, params) => { const value = await call(method, params); if (!paused && method === 'thread/queue/list' && x.w.dispatchId) { paused = true; await x.engine.pause(x.w.id); } return value; };
    return operation(rpc);
  });
  await start(x); assert.equal(x.w.status, 'paused'); assert.equal(x.Rpc.queue.length, 0); assert.equal(x.platform.log.length, 0);
});

test('open original thread only navigates to its exact local ID and does not submit messages', async t => {
  const x = await setup(t, 'inProgress'); await start(x); await x.engine.open(x.w.id);
  assert.equal(x.platform.log[0].threadId, id); assert.equal(x.platform.log[0].wake, false);
  assert.equal(x.Rpc.queue.length, 0); assert.equal(x.service.switches, 0);
});
