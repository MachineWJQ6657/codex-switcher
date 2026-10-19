import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { desktopRunning, closeDesktop } from '../electron/windows.mjs';

test('Windows closes a windowless target and descendant, keeps unrelated processes alive', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-windows-'));
  const exe = path.join(root, 'fixture-client.exe'); await copyFile(process.execPath, exe);
  const script = path.join(root, 'fixture.cjs');
  await writeFile(script, "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);");
  const child = spawn(exe, [script], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => child.once('spawn', resolve));
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await desktopRunning(exe), true);
  await closeDesktop(exe);
  assert.equal(await desktopRunning(exe), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
