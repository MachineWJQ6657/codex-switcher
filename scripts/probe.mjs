// Read-only compatibility probe. Never writes the target auth file or refreshes its tokens.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRpc } from '../electron/rpc.mjs';
import { discoverCli } from '../electron/windows.mjs';
import { parseAuth, normalizeLimits, digest } from '../electron/core.mjs';
const home = await mkdtemp(path.join(os.tmpdir(), 'deck-probe-'));
const rpc = new CodexRpc(await discoverCli(), home, { ephemeral: true });
try {
  await rpc.initialize();
  console.log('App Server initialize: OK');
  if (process.argv.includes('--live')) {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    const before = await readFile(file, 'utf8'); const { auth } = parseAuth(before);
    await rpc.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id });
    const result = await rpc.call('account/rateLimits/read');
    console.log(`Quota read: OK (${normalizeLimits(result).length} buckets, no credentials printed)`);
    if (digest(await readFile(file, 'utf8')) !== digest(before)) throw new Error('Target auth changed during probe');
    console.log('Target auth unchanged: OK');
  } else {
    const result = await rpc.call('account/read', { refreshToken: false });
    console.log(`Isolated account/read: ${result.account === null ? 'OK (no inherited account)' : 'unexpected inherited account'}`);
  }
} finally { await rpc.close(); await rm(home, { recursive: true, force: true }); }
