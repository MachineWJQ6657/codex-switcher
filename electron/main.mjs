import { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { AccountService } from './service.mjs';
import { discoverCli, discoverDesktop } from './windows.mjs';
import { safeError } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = !app.isPackaged && process.env.ACCOUNT_DECK_SMOKE === '1';
if (smoke) app.setPath('userData', path.join(os.tmpdir(), 'codex-deck-ui-test'));
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let win, service, quitting = false;
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
  const defaults = { cliPath: await discoverCli(), desktopPath: await discoverDesktop(), codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), pollSeconds: 60, autoSync: true };
  service = new AccountService({ directory: app.getPath('userData'), crypto: safeStorage, defaults });
  if (smoke) {
    const { installSmoke } = await import('../tests/ui-fixture.mjs');
    installSmoke(service, defaults);
  } else {
    try { await service.init(); }
    catch (e) { dialog.showErrorBox('无法打开账号保险库', safeError(e)); app.quit(); }
  }
  if (smoke || service.vault.data) {
    win = new BrowserWindow({ width: 1320, height: 900, minWidth: 1000, minHeight: 700, show: !smoke,
      title: 'Codex Account Deck', backgroundColor: '#f6f8fa', autoHideMenuBar: true, icon: path.join(here, '..', 'resources', 'icon.png'),
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
    const devUrl = !app.isPackaged && process.env.ACCOUNT_DECK_DEV_URL;
    const allowed = url => devUrl ? new URL(url).origin === new URL(devUrl).origin : url === new URL('../dist/index.html', import.meta.url).href;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    service.on('changed', () => { if (!win.isDestroyed()) win.webContents.send('deck:changed'); });
    ipcMain.handle('deck:action', async (event, action, args = {}) => {
      try {
        if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !allowed(event.senderFrame.url)) throw new Error('拒绝来自未知页面的请求。');
        if (smoke && action !== 'snapshot') return { ok: false, error: '界面测试模式不操作真实账号。' };
        let value;
        switch (action) {
          case 'snapshot': value = await service.snapshot(); break;
          case 'importCurrent': value = await service.importCurrent(); break;
          case 'importFile': {
            const selected = await dialog.showOpenDialog(win, { title: '导入 ChatGPT 登录文件', filters: [{ name: 'Codex auth.json', extensions: ['json'] }], properties: ['openFile'] });
            if (selected.canceled) break;
            const file = selected.filePaths[0];
            if ((await stat(file)).size > 1024 * 1024) throw new Error('文件超过 1 MB。');
            value = await service.importFile(await readFile(file, 'utf8')); break;
          }
          case 'startLogin': {
            if (typeof args.label !== 'string' || !['browser', 'device'].includes(args.method)) throw new Error('登录参数无效。');
            value = await service.startLogin(args.label, args.method);
            if (value?.url) await openAuth(value.url); break;
          }
          case 'openLogin': if (service.login?.url) await openAuth(service.login.url); break;
          case 'cancelLogin': await service.cancelLogin(); break;
          case 'sync': value = await service.syncAll(args.id); break;
          case 'switch': if (typeof args.restart !== 'boolean') throw new Error('切换参数无效。'); value = await service.switchAccount(args.id, args.restart); break;
          case 'restore': await service.restore(); break;
          case 'remove': await service.remove(args.id); break;
          case 'rename': await service.rename(args.id, args.label); break;
          case 'settings': await service.updateSettings(args); break;
          case 'workflowThreads': value = await service.workflow.threads(); break;
          case 'workflowCreate': value = await service.workflow.create(args); break;
          case 'workflowStart': await service.workflow.start(args.id); break;
          case 'workflowPause': await service.workflow.pause(args.id); break;
          case 'workflowRemove': await service.workflow.remove(args.id); break;
          case 'workflowApprove': if (typeof args.accept !== 'boolean') throw new Error('审批参数无效。'); await service.workflow.approve(args.id, args.requestId, args.accept); break;
          case 'pick': {
            if (!['cliPath', 'desktopPath', 'codexHome', 'project'].includes(args.kind)) throw new Error('路径类型无效。');
            const result = await dialog.showOpenDialog(win, { title: args.kind === 'codexHome' ? '选择目标 CODEX_HOME 文件夹' : '选择程序',
              properties: [['codexHome', 'project'].includes(args.kind) ? 'openDirectory' : 'openFile'], ...(['codexHome', 'project'].includes(args.kind) ? {} : { filters: [{ name: 'Windows 程序', extensions: ['exe'] }] }) });
            value = result.canceled ? null : result.filePaths[0]; break;
          }
          default: throw new Error('未知操作。');
        }
        return { ok: true, value };
      } catch (e) { return { ok: false, error: safeError(e) }; }
    });
    if (devUrl) await win.loadURL(devUrl); else await win.loadFile(path.join(here, '..', 'dist', 'index.html'));
    if (!smoke && service.data.accounts.length) service.syncAll().catch(() => {});
    app.on('before-quit', event => {
      if (quitting) return;
      event.preventDefault(); quitting = true;
      service.dispose().finally(() => app.quit());
    });
  }
  app.on('window-all-closed', () => app.quit());
  }).catch(error => { dialog.showErrorBox('启动失败', safeError(error)); app.quit(); });
}
async function openAuth(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com', 'chat.openai.com'].includes(url.hostname)) throw new Error('Codex 返回的登录地址不在允许的官方域名内。');
  await shell.openExternal(url.href);
}
