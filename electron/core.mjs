import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function parseAuth(raw) {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('登录文件超过 1 MB。');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('登录文件不是有效的 JSON。'); }
  if (!value || value.auth_mode === 'apikey' || value.OPENAI_API_KEY || !value.tokens?.access_token || !value.tokens?.refresh_token || !value.tokens?.account_id || !value.tokens?.id_token) {
    throw new Error('需要 ChatGPT 登录产生的 auth.json；API Key 无法查询订阅额度。');
  }
  for (const k of ['access_token', 'refresh_token', 'account_id', 'id_token']) {
    if (typeof value.tokens[k] !== 'string' || !value.tokens[k].trim()) throw new Error('登录文件缺少有效凭据。');
  }
  let claims = {};
  try { claims = JSON.parse(Buffer.from(value.tokens.id_token.split('.')[1], 'base64url').toString()); } catch { /* display hints only */ }
  const auth = claims['https://api.openai.com/auth'] ?? {};
  // Claims are unverified display hints. The service verifies credentials during sync.
  const subject = claims.sub || digest(value.tokens.id_token);
  return { auth: value, identity: digest(`${value.tokens.account_id}:${subject}`), accountId: value.tokens.account_id,
    email: typeof claims.email === 'string' ? claims.email : null,
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : 'unknown' };
}
export function normalizeLimits(result) {
  const entries = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : result.rateLimits ? [[result.rateLimits.limitId ?? 'codex', result.rateLimits]] : [];
  return entries.filter(([, b]) => b && typeof b === 'object').map(([id, b]) => ({ id, name: b.limitName || id,
    plan: b.planType ?? null, credits: b.credits ?? null,
    windows: ['primary', 'secondary'].flatMap(key => {
      const w = b[key];
      if (!w) return [];
      const known = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent);
      return [{ key, used: known ? Math.max(0, Math.min(100, w.usedPercent)) : null,
        remaining: known ? Math.max(0, Math.min(100, 100 - w.usedPercent)) : null,
        minutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }];
    }) }));
}
export function publicAccount(a, targetIdentity) {
  const { auth, identity, ...rest } = a;
  return { ...rest, isTarget: identity === targetIdentity };
}
export class Vault {
  constructor(file, crypto) { this.file = file; this.crypto = crypto; this.data = null; }
  async load(defaults) {
    if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统凭据加密不可用，无法保存账号。');
    let encrypted;
    try { encrypted = await readFile(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (encrypted) {
      try { this.data = JSON.parse(this.crypto.decryptString(encrypted)); } catch { throw new Error('账号保险库无法解密，请使用创建它的 Windows 用户登录。原文件已保留。'); }
      if (this.data.version !== 1 || !Array.isArray(this.data.accounts)) throw new Error('账号保险库格式不受支持。');
    } else this.data = { version: 1, accounts: [], settings: defaults, events: [], backup: null };
    return this.data;
  }
  async save() { await atomicWrite(this.file, this.crypto.encryptString(JSON.stringify(this.data))); }
}
export class SerialQueue {
  tail = Promise.resolve();
  run(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
}
export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:eyJ[A-Za-z0-9_-]+\.)[A-Za-z0-9_.-]+/g, '[已隐藏凭据]').replace(/(?:sk-|rt_)[A-Za-z0-9_-]{8,}/g, '[已隐藏凭据]').slice(0, 500);
}
