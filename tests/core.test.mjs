import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault, atomicWrite, parseAuth, normalizeLimits, publicAccount, SerialQueue, safeError } from '../electron/core.mjs';
import { fixtureAuth, testCrypto } from './helpers.mjs';

test('quota preserves unknowns, zero, multiple buckets and reset windows', () => {
  const result = normalizeLimits({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 500 }, secondary: { usedPercent: 100 } },
    other: { primary: { usedPercent: null }, secondary: { usedPercent: 110 } }, unknown: null
  } });
  assert.equal(result.length, 2);
  assert.equal(result[0].windows[0].remaining, 100);
  assert.equal(result[0].windows[0].resetsAt, 500);
  assert.equal(result[0].windows[1].remaining, 0);
  assert.equal(result[1].windows[0].remaining, null);
  assert.equal(result[1].windows[1].remaining, 0);
  assert.deepEqual(normalizeLimits({}), []);
});
test('account identity separates user and workspace, independent of refreshed token', () => {
  const a = parseAuth(fixtureAuth());
  assert.equal(a.plan, 'plus');
  assert.notEqual(a.identity, parseAuth(fixtureAuth('person-1', 'workspace-team', 'business')).identity);
  assert.notEqual(a.identity, parseAuth(fixtureAuth('person-2')).identity);
  const rotated = a.auth; rotated.tokens.access_token = 'rotated';
  assert.equal(a.identity, parseAuth(JSON.stringify(rotated)).identity);
  assert.throws(() => parseAuth('{"OPENAI_API_KEY":"fixture"}'), /API Key/);
  assert.throws(() => parseAuth('null'), /ChatGPT/);
  assert.throws(() => parseAuth('invalid'), /JSON/);
});
test('renderer account never contains credential or internal identity', () => {
  const a = publicAccount({ ...parseAuth(fixtureAuth()), id: 'a', label: 'name' }, 'other');
  assert.equal(a.auth, undefined); assert.equal(a.identity, undefined); assert.equal(a.isTarget, false);
  assert.ok(!JSON.stringify(a).includes('fixture-access'));
});
test('vault is encrypted, round-trips, rejects unavailable storage and preserves corrupt file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-core-'));
  try {
    const file = path.join(root, 'account.vault'); const crypto = testCrypto();
    const a = new Vault(file, crypto); await a.load({}); a.data.accounts.push({ auth: fixtureAuth() }); await a.save();
    const raw = await readFile(file); assert.ok(!raw.includes(Buffer.from('fixture-refresh')));
    const b = new Vault(file, crypto); await b.load({}); assert.equal(b.data.accounts[0].auth, a.data.accounts[0].auth);
    await assert.rejects(() => new Vault(file, { isEncryptionAvailable: () => false }).load({}), /加密/);
    await atomicWrite(file, 'corrupt');
    await assert.rejects(() => b.load({}), /无法解密/); assert.equal(await readFile(file, 'utf8'), 'corrupt');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('queue serializes errors without breaking subsequent operations', async () => {
  const queue = new SerialQueue(), order = [];
  const first = queue.run(async () => { order.push('start'); await new Promise(resolve => setTimeout(resolve, 10)); order.push('end'); throw new Error('fixture'); });
  const second = queue.run(() => order.push('second'));
  await assert.rejects(() => first); await second; assert.deepEqual(order, ['start', 'end', 'second']);
  assert.ok(!safeError(new Error(`bad ${JSON.parse(fixtureAuth()).tokens.id_token}`)).includes('.test'));
});
test('unchanged vault data skips encryption and filesystem rewrites', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-vault-cache-'));
  const crypto = testCrypto(); let encryptions = 0;
  const original = crypto.encryptString; crypto.encryptString = value => { encryptions++; return original(value); };
  try {
    const vault = new Vault(path.join(root, 'vault'), crypto); await vault.load({});
    await vault.save(); await vault.save(); await Promise.all([vault.save(), vault.save()]);
    assert.equal(encryptions, 1);
    vault.data.events.push({ message: 'changed' }); await vault.save(); assert.equal(encryptions, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
