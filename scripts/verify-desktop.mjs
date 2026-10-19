// Explicit live integration check: one harmless reply in the official desktop, no tools or file changes.
// Creates and archives a disposable local test thread. Never closes the user's running desktop.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexRpc } from '../electron/rpc.mjs';
import { discoverCli, discoverDesktop, launchDesktop } from '../electron/windows.mjs';
if (!process.argv.includes('--live')) throw new Error('Use --live to run this test against the installed official desktop.');
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const cli = await discoverCli(), desktop = await discoverDesktop();
let rpc, threadId;
const connect = async () => { rpc = new CodexRpc(cli, home, { ephemeral: true, timeout: 60000 }); await rpc.initialize(); };
try {
  await connect();
  // Seed a durable fixture history without inheriting the actual account into the fixture process.
  const { thread } = await rpc.call('thread/start', { cwd: os.tmpdir(), ephemeral: false, model: 'gpt-6.1-sol' });
  threadId = thread.id;
  await rpc.call('thread/name/set', { threadId, name: 'Account Deck official desktop integration check' });
  const finished = new Promise(resolve => rpc.on('notification', m => { if (m.method === 'turn/completed') resolve(); }));
  await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: 'Integration fixture. Reply only OK. Do not use tools.' }] });
  await Promise.race([finished, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture setup timeout')), 90000); timer.unref(); })]);
  await rpc.close();
  console.log('Durable fixture ready; independent fixture process closed.');
  await connect();
  const { thread: before } = await rpc.call('thread/read', { threadId, includeTurns: true });
  const beforeCount = before.turns.length;
  const clientUserMessageId = randomUUID();
  await rpc.call('thread/queue/add', { threadId, clientUserMessageId,
    input: [{ type: 'text', text: 'This is an Account Deck desktop handoff verification. Reply exactly ACCOUNT_DECK_DESKTOP_HANDOFF_OK. Do not call tools, change files, or start any other work.' }] });
  const { thread: dormant } = await rpc.call('thread/read', { threadId, includeTurns: true });
  assert.equal(dormant.turns.length, beforeCount, 'Queue storage must not start a turn in Account Deck');
  await rpc.close();
  await launchDesktop(desktop, { threadId, home });
  console.log('Official desktop opened and woken with the queued message.');
  const end = Date.now() + 90000; let verified = false;
  while (Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await connect();
    const { thread: after } = await rpc.call('thread/read', { threadId, includeTurns: true });
    const turn = after.turns.at(-1);
    await rpc.close();
    if (after.turns.length > beforeCount && turn.status === 'completed') {
      assert.ok(turn.items.some(i => i.type === 'agentMessage' && i.text.includes('ACCOUNT_DECK_DESKTOP_HANDOFF_OK')));
      console.log('PASS: original queued message completed inside official desktop; Account Deck performed no inference.');
      verified = true;
      break;
    }
    if (Date.now() + 2000 >= end) throw new Error(`Official desktop did not complete the fixture (last status: ${turn.status}).`);
  }
  assert.ok(verified, 'Official desktop handoff did not finish before the deadline');
} finally {
  if (rpc) await rpc.close();
  if (threadId) {
    await connect();
    try { await rpc.call('thread/archive', { threadId }); }
    catch (error) {
      if (!/active writer/.test(error.message)) throw error;
      console.log(`Fixture ${threadId} is still held by the official desktop; archive it through the desktop after verification.`);
    } finally { await rpc.close(); }
  }
}
