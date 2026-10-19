import { _electron as electron } from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.ACCOUNT_DECK_DEV_URL; delete env.ACCOUNT_DECK_SMOKE;
const version = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version;
const output = path.resolve('release', version, 'win-unpacked');
const profile = await mkdtemp(path.join(os.tmpdir(), 'deck-package-check-'));
const application = await electron.launch({ executablePath: path.join(output, 'CodexAccountDeck.exe'), args: [`--user-data-dir=${profile}`], env, timeout: 30000 });
try {
  const page = await application.firstWindow({ timeout: 30000 });
  await page.getByRole('heading', { name: '账号总览' }).waitFor();
  const result = await application.evaluate(({ app, safeStorage }) => {
    const plain = 'account-deck-encryption-probe';
    const encrypted = safeStorage.encryptString(plain);
    return { packaged: app.isPackaged, available: safeStorage.isEncryptionAvailable(),
      encrypted: !encrypted.includes(Buffer.from(plain)), roundtrip: safeStorage.decryptString(encrypted) === plain };
  });
  assert.deepEqual(result, { packaged: true, available: true, encrypted: true, roundtrip: true });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.ok(await page.evaluate(async () => (await window.deck.snapshot()).ok));
  await page.getByRole('button', { name: '自动工作流', exact: true }).click();
  await page.getByRole('heading', { name: '自动工作流' }).waitFor();
  const asar = await stat(path.join(output, 'resources/app.asar'));
  await new Promise(resolve => setTimeout(resolve, 8000));
  const first = await application.evaluate(({ app }) => Object.fromEntries(app.getAppMetrics().map(p => [p.pid, p.cpu.cumulativeCPUUsage])));
  const started = performance.now(); await new Promise(resolve => setTimeout(resolve, 5000));
  const resources = await application.evaluate(({ app }) => { const metrics = app.getAppMetrics(); return { cpuByPid: Object.fromEntries(metrics.map(p => [p.pid, p.cpu.cumulativeCPUUsage])), processes: metrics.length, privateMB: metrics.reduce((sum, p) => sum + p.memory.privateBytes / 1024, 0), cpuSeconds: metrics.reduce((sum, p) => sum + p.cpu.cumulativeCPUUsage, 0) }; });
  const cpu = Object.entries(resources.cpuByPid).reduce((sum, [pid, seconds]) => sum + (pid in first ? Math.max(0, seconds - first[pid]) : 0), 0) / ((performance.now() - started) / 1000) * 100;
  console.log(`Idle isolated profile: ${resources.processes} processes, ${resources.privateMB.toFixed(1)} MB private memory, ${cpu.toFixed(2)}% of one CPU core; app.asar ${(asar.size / 1024).toFixed(0)} KB`);
  console.log('Packaged Windows app: PASS (startup, IPC, sandbox, actual OS credential encryption)');
} finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
