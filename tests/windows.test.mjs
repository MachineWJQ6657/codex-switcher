import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { desktopRunning, closeDesktop, desktopLinks, threadWriters } from '../electron/windows.mjs';

test('official desktop launch opens the same thread and wakes its existing queue without prompt injection', () => {
  const id = '01a15651-9fa2-7291-a6ff-b9def0813806';
  assert.deepEqual(desktopLinks(id), [`codex://threads/wake/${id}`, `codex://threads/${id}?hostId=local`]);
  assert.throws(() => desktopLinks('id?prompt=unrelated'), /无效/);
});

test('read-only writer probe distinguishes a Windows byte lock from a stale zero-byte lock file', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-writer-'));
  const directory = path.join(root, 'thread-writer-locks'); await mkdir(directory);
  const id = '01a15651-9fa2-7291-a6ff-b9def0813806'; const file = path.join(directory, `${id}.lock`); await writeFile(file, '');
  assert.deepEqual(await threadWriters(root), { busy: [], unknown: false });
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:DECK_LOCK_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);try{$f.Lock(0,1);[Console]::WriteLine('locked');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null;$f.Unlock(0,1)}finally{$f.Dispose()}"], { windowsHide: true, env: { ...process.env, DECK_LOCK_FIXTURE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  assert.deepEqual(await threadWriters(root), { busy: [id], unknown: false });
  const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await closed;
  assert.deepEqual(await threadWriters(root), { busy: [], unknown: false });
});

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
