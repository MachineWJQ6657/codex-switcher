import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function rendererTarget(appRoot) {
  const file = path.resolve(appRoot, 'dist', 'index.html');
  return { file, url: pathToFileURL(file).href };
}
export function permittedRendererURL(candidate, target, devURL = null) {
  try {
    const url = new URL(candidate);
    if (devURL) return url.origin === new URL(devURL).origin;
    if (url.protocol !== 'file:') return false;
    const expected = path.resolve(target.file), actual = path.resolve(fileURLToPath(url));
    return process.platform === 'win32' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
  } catch { return false; }
}
