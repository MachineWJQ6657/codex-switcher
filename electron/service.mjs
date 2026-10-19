import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, atomicWrite, parseAuth, normalizeLimits, publicAccount, safeError, SerialQueue, digest } from './core.mjs';
import { CodexRpc } from './rpc.mjs';
import * as windows from './windows.mjs';
import { WorkflowEngine } from './workflow.mjs';

export class AccountService extends EventEmitter {
  queue = new SerialQueue();
  login = null;
  syncing = false;
  fatal = null;
  sessions = new Set();
  constructor({ directory, crypto, defaults, platform = windows, Rpc = CodexRpc }) {
    super(); this.directory = directory; this.defaults = defaults; this.platform = platform; this.Rpc = Rpc;
    this.vault = new Vault(path.join(directory, 'accounts.vault'), crypto);
    this.workflow = new WorkflowEngine(this);
  }
  get data() { if (this.fatal) throw new Error(this.fatal); return this.vault.data; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    await this.vault.load(this.defaults);
    this.data.workflows ??= [];
    await this.workflow.recover();
    // Recover only our own disposable session folders after a crash.
    const root = path.join(this.directory, '.sessions');
    await mkdir(root, { recursive: true });
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (d.isDirectory() && /^session-[A-Za-z0-9]+$/.test(d.name)) await rm(path.join(root, d.name), { recursive: true, force: true });
    }
    this.schedule();
    this.workflow.schedule();
  }
  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!this.login && this.data.settings.autoSync) this.syncAll().catch(() => {}); }, this.data.settings.pollSeconds * 1000);
  }
  async target() {
    try {
      const raw = await readFile(path.join(this.data.settings.codexHome, 'auth.json'), 'utf8');
      const parsed = parseAuth(raw);
      return { ...parsed, raw, hash: digest(raw) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async snapshot() {
    let current = null, targetError = null;
    try { current = await this.target(); } catch (error) { targetError = safeError(error); }
    return { accounts: this.data.accounts.map(a => publicAccount(a, current?.identity)), settings: this.data.settings,
      events: this.data.events.slice(0, 40), target: current ? { email: current.email, accountId: current.accountId } : null,
      targetError, syncing: this.syncing, login: this.login ? { label: this.login.label, url: this.login.url, code: this.login.code } : null,
      canRestore: Boolean(this.data.backup), platform: process.platform, workflows: this.workflow.snapshot() };
  }
  publish() { this.emit('changed'); }
  event(message, type = 'info') { this.data.events.unshift({ id: randomUUID(), at: Date.now(), message, type }); this.data.events = this.data.events.slice(0, 80); }
  async put(raw, label = '') {
    const parsed = parseAuth(raw);
    let account = this.data.accounts.find(a => a.identity === parsed.identity);
    if (account) { account.auth = parsed.auth; if (label.trim()) account.label = label.trim().slice(0, 80); account.error = null; }
    else {
      account = { id: randomUUID(), identity: parsed.identity, auth: parsed.auth, accountId: parsed.accountId,
        label: label.trim().slice(0, 80) || parsed.email || 'ChatGPT 账号', email: parsed.email, plan: parsed.plan,
        limits: [], syncedAt: null, error: null, addedAt: Date.now() };
      this.data.accounts.push(account);
    }
    this.event(`已保存账号「${account.label}」`);
    await this.vault.save(); this.publish(); return account.id;
  }
  importCurrent() { return this.queue.run(async () => {
    const current = await this.target();
    if (!current) throw new Error('当前目录没有 auth.json；可使用浏览器登录添加账号。若使用系统凭据库，请先查看 README 的兼容性说明。');
    return this.put(current.raw);
  }); }
  importFile(raw) { return this.queue.run(() => this.put(raw)); }
  rename(id, label) { return this.queue.run(async () => { const a = this.find(id); if (!label?.trim()) throw new Error('请输入账号备注。'); a.label = label.trim().slice(0, 80); await this.vault.save(); this.publish(); }); }
  remove(id) { return this.queue.run(async () => { if (this.workflow.usesAccount(id)) throw new Error('该账号正在工作流候选池中，请先暂停或移除工作流。'); const a = this.find(id); this.data.accounts = this.data.accounts.filter(x => x.id !== id); this.event(`已移除「${a.label}」`); await this.vault.save(); this.publish(); }); }
  find(id) { const a = this.data.accounts.find(x => x.id === id); if (!a) throw new Error('账号不存在。'); return a; }
  async session(auth, { ephemeral = false } = {}) {
    const executable = this.data.settings.cliPath;
    if (!executable) throw new Error('未检测到 Codex CLI，请在设置中选择 codex.exe。');
    const home = await mkdtemp(path.join(this.directory, '.sessions', 'session-'));
    let rpc;
    try {
      if (auth && !ephemeral) await atomicWrite(path.join(home, 'auth.json'), JSON.stringify(auth));
      rpc = new this.Rpc(executable, home, { ephemeral }); this.sessions.add(rpc);
      await rpc.initialize();
      if (ephemeral && auth) await rpc.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id });
      return { rpc, home, close: async () => { await rpc.close(); this.sessions.delete(rpc); await rm(home, { recursive: true, force: true }); } };
    } catch (error) { if (rpc) { await rpc.close(); this.sessions.delete(rpc); } await rm(home, { recursive: true, force: true }); throw error; }
  }
  async startLogin(label, method = 'browser') {
    if (this.login) throw new Error('已有登录正在进行，请先完成或取消。');
    const entry = { label: String(label || '').slice(0, 80), session: null, url: '', code: null, timeout: null };
    this.login = entry; this.publish();
    try {
      const session = await this.session();
      if (this.login !== entry) { await session.close(); return null; }
      entry.session = session;
      session.rpc.on('notification', msg => {
        if (msg.method !== 'account/login/completed') return;
        // A completion can arrive before the login/start response.
        entry.completed = msg.params;
        if (entry.ready) this.finishLogin(entry).catch(() => {});
      });
      const result = await session.rpc.call('account/login/start', { type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
      entry.loginId = result.loginId; entry.url = result.authUrl || result.verificationUrl; entry.code = result.userCode || null;
      entry.ready = true;
      entry.timeout = setTimeout(() => this.cancelLogin().catch(() => {}), 10 * 60 * 1000);
      if (entry.completed) await this.finishLogin(entry);
      this.publish();
      return { url: entry.url, code: entry.code };
    } catch (error) { if (this.login === entry) await this.cancelLogin(); throw error; }
  }
  async finishLogin(entry) {
    if (this.login !== entry || entry.finishing) return;
    entry.finishing = true; clearTimeout(entry.timeout);
    try {
      if (!entry.completed.success) throw new Error(entry.completed.error || '登录未完成。');
      const raw = await readFile(path.join(entry.session.home, 'auth.json'), 'utf8');
      await this.queue.run(() => this.put(raw, entry.label));
    } catch (e) { this.event(`添加账号失败：${safeError(e)}`, 'error'); await this.vault.save(); }
    finally { await entry.session.close(); if (this.login === entry) this.login = null; this.publish(); }
  }
  async cancelLogin() {
    const entry = this.login;
    if (!entry || entry.finishing) return;
    this.login = null; clearTimeout(entry.timeout);
    if (entry.session) {
      if (entry.loginId) await entry.session.rpc.call('account/login/cancel', { loginId: entry.loginId }).catch(() => {});
      await entry.session.close();
    }
    this.publish();
  }
  syncAll(onlyId) {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync(onlyId).finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }
  performSync(onlyId) { return this.queue.run(async () => {
    if (this.stopping) return;
    this.syncing = true; this.publish();
    try {
      for (const account of this.data.accounts.filter(a => !onlyId || a.id === onlyId)) {
        if (this.stopping) break;
        let session;
        try {
          const target = await this.target();
          const isTarget = target?.identity === account.identity;
          if (isTarget) account.auth = target.auth;
          // The live desktop owns token renewal for its account. Never rotate its refresh token in another process.
          session = await this.session(account.auth, { ephemeral: isTarget });
          let info;
          if (!isTarget) info = await session.rpc.call('account/read', { refreshToken: false });
          if (info?.account?.type === 'chatgpt') { account.email = info.account.email; account.plan = info.account.planType || account.plan; }
          const result = await session.rpc.call('account/rateLimits/read');
          account.limits = normalizeLimits(result);
          account.syncedAt = Date.now(); account.error = null;
        } catch (e) { account.error = safeError(e); }
        finally {
          if (session) {
            // Preserve rotated managed credentials even when a quota request fails.
            try {
              const raw = await readFile(path.join(session.home, 'auth.json'), 'utf8');
              if (parseAuth(raw).identity === account.identity) account.auth = JSON.parse(raw);
            } catch { /* ephemeral mode has no credential file */ }
            await session.close();
          }
        }
        await this.vault.save(); this.publish();
      }
    } finally { this.syncing = false; this.publish(); }
  }); }
  async checkTargetConfig() {
    let text = '';
    try { text = await readFile(path.join(this.data.settings.codexHome, 'config.toml'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const store = text.match(/^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)/m)?.[1];
    if (store && store !== 'file') throw new Error(`目标使用 ${store} 凭据存储。请在目标 config.toml 中显式设置 cli_auth_credentials_store = "file"，然后重新登录并导入。`);
    if (/^\s*forced_chatgpt_workspace_id\s*=/m.test(text) || /^\s*forced_login_method\s*=\s*["']api["']/m.test(text)) throw new Error('目标配置限制了登录方式或工作空间，请先检查组织配置。');
  }
  switchAccount(id, restart = true, workflowId = null) { return this.queue.run(async () => {
    this.workflow.assertOwnership(workflowId);
    if (workflowId && this.workflow.active?.id !== workflowId) throw new Error('工作流已暂停，切换已取消。');
    const account = this.find(id);
    const { settings } = this.data;
    await this.checkTargetConfig();
    const exe = this.platform.resolveDesktop ? await this.platform.resolveDesktop(settings.desktopPath) : settings.desktopPath;
    if (exe !== settings.desktopPath) settings.desktopPath = exe;
    if (!exe) throw new Error('请先在设置中选择 Codex / ChatGPT 桌面程序，以便确认它已退出。');
    await access(exe);
    const running = await this.platform.desktopRunning(exe);
    if (running && !restart) throw new Error('客户端仍在运行，请退出后切换，或使用「切换并重启」。');
    if (running) await this.platform.closeDesktop(exe);
    if (workflowId && this.workflow.active?.id !== workflowId) throw new Error('工作流已暂停，切换已取消。');
    // Re-read after the desktop has flushed any refreshed credentials on exit.
    const previous = await this.target();
    if (previous) {
      const old = this.data.accounts.find(a => a.identity === previous.identity);
      if (old) old.auth = previous.auth;
    }
    const previousRaw = previous?.raw ?? null;
    this.data.backup = { raw: previousRaw, at: Date.now(), appliedHash: digest(JSON.stringify(account.auth)) };
    await this.vault.save(); // Persist encrypted rollback material before changing target.
    const file = path.join(settings.codexHome, 'auth.json');
    // Compare immediately before replacement to detect another login changing the file.
    const latest = await this.target();
    if ((latest?.hash ?? null) !== (previous?.hash ?? null)) throw new Error('目标登录状态已被其他程序修改，请重试。');
    await atomicWrite(file, JSON.stringify(account.auth));
    this.event(`已写入「${account.label}」的本地登录状态${restart ? '，准备重启客户端' : ''}`);
    await this.vault.save(); this.publish();
    if (restart) {
      try { await this.platform.launchDesktop(exe); }
      catch { this.event('登录状态已切换，但客户端启动失败，请手动打开或恢复上次切换。', 'error'); await this.vault.save(); this.publish(); throw new Error('登录状态已写入，但客户端启动失败。可手动打开客户端或恢复上次切换。'); }
    }
    return { message: '本地登录状态已切换。请在目标客户端核对账号；桌面应用兼容性取决于其登录存储方式。' };
  }); }
  restore() { return this.queue.run(async () => {
    this.workflow.assertOwnership(null);
    const backup = this.data.backup;
    if (!backup) throw new Error('没有可恢复的切换记录。');
    const exe = this.data.settings.desktopPath;
    if (!exe || await this.platform.desktopRunning(exe)) throw new Error('请先退出目标客户端，再恢复上次切换。');
    const file = path.join(this.data.settings.codexHome, 'auth.json');
    let raw = null;
    try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw === null || digest(raw) !== backup.appliedHash) throw new Error('目标凭据已更新，为避免覆盖新登录，未执行恢复。');
    if (backup.raw === null) await rm(file, { force: true }); else await atomicWrite(file, backup.raw);
    this.data.backup = null; this.event('已恢复切换前的登录状态'); await this.vault.save(); this.publish();
  }); }
  updateSettings(patch) { return this.queue.run(async () => {
    if (['cliPath', 'desktopPath', 'codexHome'].some(k => k in patch)) this.workflow.assertOwnership(null);
    const next = { ...this.data.settings };
    for (const key of ['cliPath', 'desktopPath', 'codexHome']) {
      if (key in patch) {
        if (typeof patch[key] !== 'string' || !path.isAbsolute(patch[key]) || patch[key].length > 1024) throw new Error('请选择有效的绝对路径。');
        if (key !== 'codexHome') { if (path.extname(patch[key]).toLowerCase() !== '.exe') throw new Error('请选择 .exe 程序。'); await access(patch[key]); }
        next[key] = path.resolve(patch[key]);
      }
    }
    if ('pollSeconds' in patch) { if (!Number.isInteger(patch.pollSeconds) || patch.pollSeconds < 30 || patch.pollSeconds > 3600) throw new Error('同步间隔应为 30–3600 秒。'); next.pollSeconds = patch.pollSeconds; }
    if ('autoSync' in patch) next.autoSync = Boolean(patch.autoSync);
    if (next.codexHome !== this.data.settings.codexHome) this.data.backup = null;
    this.data.settings = next; await this.vault.save(); this.schedule(); this.publish();
  }); }
  async dispose() { this.stopping = true; clearInterval(this.timer); await this.workflow.dispose(); await this.cancelLogin(); await Promise.allSettled([...this.sessions].map(x => x.close())); await this.queue.tail; }
}
