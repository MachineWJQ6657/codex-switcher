import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccountService } from '../electron/service.mjs';
import { parseAuth } from '../electron/core.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';
class FakeRpc extends EventEmitter {
  static instances = []; static fail = false;
  constructor(executable, home, options) { super(); this.home = home; this.options = options; FakeRpc.instances.push(this); }
  async initialize() {}
  async close() { this.closed = true; }
  async call(method, params) {
    if (method === 'account/login/start' && params.type === 'chatgptAuthTokens') return {};
    if (method === 'account/read') {
      const file = path.join(this.home, 'auth.json'); const auth = JSON.parse(await readFile(file, 'utf8'));
      auth.tokens.refresh_token = 'fixture-rotated'; await writeFile(file, JSON.stringify(auth));
      return { account: { type: 'chatgpt', email: 'verified@example.test', planType: 'business' } };
    }
    if (method === 'account/rateLimits/read') { if (FakeRpc.fail) throw new Error('fixture offline'); return { rateLimits: { primary: { usedPercent: 67, windowDurationMins: 300 } } }; }
    if (method === 'account/login/start') { setTimeout(async () => { await writeFile(path.join(this.home, 'auth.json'), fixtureAuth('oauth-person')); this.emit('notification', { method: 'account/login/completed', params: { success: true } }); }, 5); return { loginId: 'fixture-login', authUrl: 'https://auth.openai.com/test' }; }
    return {};
  }
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-service-'));
  const targetHome = path.join(root, 'target'); await mkdir(targetHome);
  const exe = path.join(root, 'fixture.exe'); await writeFile(exe, 'fixture');
  const state = { running: false, launched: 0, closeFails: false, generation: 1 };
  const platform = { desktopState: async () => state.running ? [{ pid: state.generation, startedAt: String(state.generation), window: true }] : [], desktopRunning: async () => state.running, closeDesktop: async () => { if (state.closeFails) throw new Error('fixture busy'); state.running = false; }, launchDesktop: async () => { state.launched++; state.generation++; return { pid: state.generation, window: true }; } };
  FakeRpc.fail = false; FakeRpc.instances = [];
  const service = new AccountService({ directory: path.join(root, 'data'), crypto: testCrypto(), defaults: { cliPath: exe, desktopPath: exe, codexHome: targetHome, autoSync: false, pollSeconds: 60 }, platform, Rpc: FakeRpc });
  await service.init();
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, root, targetHome, file: path.join(targetHome, 'auth.json'), state };
}
test('import deduplicates and snapshot hides secrets while matching target', async t => {
  const { service, file } = await setup(t); const before = fixtureAuth(); await writeFile(file, before);
  const id = await service.importCurrent(); assert.equal(await service.importFile(fixtureAuth()), id);
  await service.importFile(fixtureAuth('person-1', 'business-space', 'business'));
  const snapshot = await service.snapshot(); assert.equal(snapshot.accounts.length, 2); assert.equal(snapshot.accounts[0].isTarget, true);
  assert.ok(!JSON.stringify(snapshot).includes('fixture-access'));
  await service.remove(id); assert.equal(await readFile(file, 'utf8'), before);
});
test('sync uses ephemeral current credentials, preserves rotated inactive credentials, cleans sessions and retains stale limits', async t => {
  const { service, file, root } = await setup(t); const raw = fixtureAuth(); await writeFile(file, raw);
  const currentId = await service.importCurrent(); const otherId = await service.importFile(fixtureAuth('other'));
  await service.syncAll();
  assert.equal(service.find(currentId).limits[0].windows[0].remaining, 33);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal(FakeRpc.instances[0].options.ephemeral, true);
  assert.equal(service.find(otherId).auth.tokens.refresh_token, 'fixture-rotated');
  assert.deepEqual(await readdir(path.join(root, 'data', '.sessions')), []);
  const synced = service.find(otherId).syncedAt; FakeRpc.fail = true; await service.syncAll(otherId);
  assert.equal(service.find(otherId).syncedAt, synced); assert.match(service.find(otherId).error, /offline/);
  assert.equal(service.find(otherId).limits[0].windows[0].remaining, 33);
});
test('failed graceful exit leaves target unchanged; successful switch has encrypted rollback', async t => {
  const { service, file, state, root } = await setup(t); const before = fixtureAuth(); await writeFile(file, before);
  await service.importCurrent(); const id = await service.importFile(fixtureAuth('other'));
  state.running = true; state.closeFails = true;
  await assert.rejects(() => service.switchAccount(id, true), /busy/); assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(() => service.switchAccount(id, false), /仍在运行/);
  state.closeFails = false; await service.switchAccount(id, true);
  assert.equal(parseAuth(await readFile(file, 'utf8')).identity, service.find(id).identity); assert.equal(state.launched, 1);
  assert.ok(!(await readFile(path.join(root, 'data', 'accounts.vault'))).includes(Buffer.from('fixture-refresh')));
  await service.restore(); assert.equal(await readFile(file, 'utf8'), before);
});
test('restore refuses to overwrite tokens updated after switch', async t => {
  const { service, file } = await setup(t); await writeFile(file, fixtureAuth());
  const id = await service.importFile(fixtureAuth('other')); await service.switchAccount(id, false);
  const newAuth = fixtureAuth('third'); await writeFile(file, newAuth);
  await assert.rejects(() => service.restore(), /凭据已更新/); assert.equal(await readFile(file, 'utf8'), newAuth);
});
test('keyring and workspace restrictions block file switching', async t => {
  const { service, targetHome, file } = await setup(t); const before = fixtureAuth(); await writeFile(file, before);
  const id = await service.importFile(fixtureAuth('other'));
  await writeFile(path.join(targetHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  await assert.rejects(() => service.switchAccount(id), /keyring/); assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(path.join(targetHome, 'config.toml'), 'forced_chatgpt_workspace_id = "managed"');
  await assert.rejects(() => service.switchAccount(id), /限制/);
});
test('browser OAuth completion persists credentials and cleans temporary home', async t => {
  const { service, root } = await setup(t); await service.startLogin('OAuth Test');
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('login timeout')), 3000); const check = () => { if (!service.login) { clearTimeout(timeout); service.off('changed', check); resolve(); } }; service.on('changed', check); check(); });
  assert.equal(service.data.accounts[0].label, 'OAuth Test'); assert.equal(service.data.accounts[0].email, 'oauth-person@example.test');
  assert.deepEqual(await readdir(path.join(root, 'data', '.sessions')), []);
});
test('due-only sync refreshes selected expired accounts and reuses fresh quota without another CLI', async t => {
  const { service } = await setup(t);
  const one = await service.importFile(fixtureAuth('one')), two = await service.importFile(fixtureAuth('two'));
  await service.syncAll([one], true); assert.equal(FakeRpc.instances.length, 1);
  await service.syncAll([one], true); assert.equal(FakeRpc.instances.length, 1);
  assert.equal(service.find(two).syncedAt, null);
  service.find(one).syncedAt = Date.now() - 61000;
  await service.syncAll([one], true); assert.equal(FakeRpc.instances.length, 2);
});
test('empty account list schedules no background polling', async t => {
  const { service } = await setup(t); service.data.settings.autoSync = true; service.schedule();
  assert.ok(!service.timer);
});
test('official installation paths follow updates, custom overrides stay local and credentials survive reload', async t => {
  const { service, root } = await setup(t);
  const id = await service.importFile(fixtureAuth('persistent'));
  const newExe = path.join(root, 'updated.exe'); await writeFile(newExe, 'fixture-new');
  service.data.settings.cliAutoDetect = true; service.data.settings.desktopAutoDetect = true;
  service.platform.discoverCli = async () => newExe; service.platform.discoverDesktop = async () => newExe;
  await service.refreshRuntimePaths(true);
  assert.equal(service.data.settings.cliPath, newExe); assert.equal(service.data.settings.desktopPath, newExe);
  const custom = path.join(root, 'custom.exe'); await writeFile(custom, 'custom');
  await service.updateSettings({ cliPath: custom }); await service.refreshRuntimePaths(true);
  assert.equal(service.data.settings.cliPath, custom); assert.equal(service.data.settings.cliAutoDetect, false);
  const restored = await service.vault.load({});
  assert.equal(restored.accounts[0].id, id); assert.equal(restored.accounts[0].auth.tokens.refresh_token, 'fixture-refresh');
  assert.equal(restored.settings.cliPath, custom);
});

test('an in-flight sync for one account cannot swallow a simultaneous current-account workflow refresh', async t => {
  const { service } = await setup(t);
  let release; const gate = new Promise(resolve => { release = resolve; }); const requests = [];
  service.performSync = async ids => { requests.push(ids); if (requests.length === 1) await gate; };
  const background = service.syncAll(['inactive-account']);
  const workflow = service.syncAll(['current-account']);
  release(); await Promise.all([background, workflow]);
  assert.deepEqual(requests, [['inactive-account'], ['current-account']]);
});

test('launcher returning without a new window is a failed switch, never success', async t => {
  const { service, state } = await setup(t); const id = await service.importFile(fixtureAuth('other'));
  service.platform.launchDesktop = async () => { state.launched++; return undefined; };
  await assert.rejects(() => service.switchAccount(id, true), /没有重新打开/);
  assert.equal(service.switchState.stage, 'failed');
  assert.equal(service.data.events.some(e => e.message.startsWith('已重新打开客户端')), false);
});

test('client that stays running blocks credential replacement even when close returns successfully', async t => {
  const { service, state, file } = await setup(t); const before = fixtureAuth(); await writeFile(file, before);
  const id = await service.importFile(fixtureAuth('other')); state.running = true;
  service.platform.closeDesktop = async () => {};
  await assert.rejects(() => service.switchAccount(id, true), /还没退出/);
  assert.equal(await readFile(file, 'utf8'), before); assert.equal(service.switchState.stage, 'failed');
});

test('client rewriting auth to another account on launch is a failed switch', async t => {
  const { service, file } = await setup(t); const id = await service.importFile(fixtureAuth('other'));
  service.platform.launchDesktop = async () => { await writeFile(file, fixtureAuth('unexpected')); return { pid: 5, window: true }; };
  await assert.rejects(() => service.switchAccount(id, true), /没有成功/);
  assert.equal(service.switchState.stage, 'failed');
});

test('file-only switching tells the user the client has not been opened', async t => {
  const { service, state } = await setup(t); const id = await service.importFile(fixtureAuth('other'));
  const result = await service.switchAccount(id, false);
  assert.equal(result.restarted, false); assert.match(result.message, /还没打开/); assert.equal(state.launched, 0);
});
