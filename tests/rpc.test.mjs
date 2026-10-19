import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRpc } from '../electron/rpc.mjs';
import os from 'node:os';
test('missing CLI rejects requests and closes without hanging', { timeout: 5000 }, async () => {
  const rpc = new CodexRpc('this-fixture-cli-does-not-exist.exe', os.tmpdir(), { timeout: 1000 });
  await assert.rejects(() => rpc.initialize(), /无法启动|退出/);
  await rpc.close();
});
