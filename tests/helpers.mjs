import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export function fixtureAuth(subject = 'person-1', workspace = 'workspace-personal', plan = 'plus') {
  const claims = { sub: subject, email: `${subject}@example.test`, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } };
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', account_id: workspace,
    id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test` }, last_refresh: new Date().toISOString() });
}
// Injected only into Node tests. The shipped application always uses Electron safeStorage.
export function testCrypto() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString(value) { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(); }
  };
}
