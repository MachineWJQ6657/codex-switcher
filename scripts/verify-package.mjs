import { _electron as electron } from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.ACCOUNT_DECK_DEV_URL; delete env.ACCOUNT_DECK_SMOKE;
const application = await electron.launch({ executablePath: path.resolve('release/win-unpacked/CodexAccountDeck.exe'), args: ['--disable-gpu'], env, timeout: 30000 });
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
  console.log('Packaged Windows app: PASS (startup, IPC, sandbox, actual OS credential encryption)');
} finally { await application.close(); }
