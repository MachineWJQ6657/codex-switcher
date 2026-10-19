import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rendererTarget, permittedRendererURL } from '../electron/renderer.mjs';
test('renderer file URL encodes spaces, Unicode and URL metacharacters from install locations', () => {
  const root = path.resolve('安装目录 with spaces #100%', 'resources', 'app.asar');
  const target = rendererTarget(root);
  assert.ok(target.url.startsWith('file:///'));
  assert.ok(!target.url.includes('\\'));
  assert.ok(target.url.includes('%20')); assert.ok(target.url.includes('%23')); assert.ok(target.url.includes('%25'));
  assert.equal(permittedRendererURL(target.url, target), true);
  assert.equal(permittedRendererURL(`${target.url}#workflow`, target), true);
  assert.equal(permittedRendererURL(`${target.url}?view=accounts`, target), true);
  assert.equal(permittedRendererURL(target.url.replace('/index.html', '/other.html'), target), false);
  assert.equal(permittedRendererURL('https://example.test/', target), false);
});
test('navigation compares Windows paths independently of drive/path casing', { skip: process.platform !== 'win32' }, () => {
  const target = rendererTarget('D:\\Projects\\multi-account\\release\\0.3.1\\resources\\app.asar');
  assert.equal(permittedRendererURL(target.url.toLowerCase(), target), true);
  assert.equal(permittedRendererURL('not a URL', target), false);
});
