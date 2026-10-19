import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter, once } from 'node:events';

export class CodexRpc extends EventEmitter {
  nextId = 1;
  pending = new Map();
  constructor(executable, home, { timeout = 30000, ephemeral = false } = {}) {
    super();
    this.timeout = timeout;
    const env = { ...process.env, CODEX_HOME: home };
    // Ambient credentials must never override the selected account.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ACCESS_TOKEN']) delete env[key];
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', `cli_auth_credentials_store="${ephemeral ? 'ephemeral' : 'file'}"`],
      { env, cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if ('id' in msg && (msg.result !== undefined || msg.error)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'Codex 请求失败。'));
        else p.resolve(msg.result);
      } else if ('id' in msg) {
        if (this.listenerCount('request')) this.emit('request', msg);
        else this.send({ id: msg.id, error: { code: -32601, message: 'This client does not support server requests. Reauthenticate if required.' } });
      } else this.emit('notification', msg);
    });
    this.child.stderr.resume(); // Never log raw output: it can contain credentials.
    this.child.stdin.on('error', () => this.fail(new Error('Codex 连接已关闭。')));
    this.child.on('error', () => this.fail(new Error('无法启动 Codex CLI，请在设置中选择有效的 codex.exe。')));
    this.child.on('close', () => { this.ended = true; this.fail(new Error('Codex App Server 已退出。')); this.emit('closed'); });
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  send(msg) { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(msg)}\n`); }
  call(method, params = {}, timeout = this.timeout) {
    if (this.ended) return Promise.reject(new Error('Codex 连接已关闭。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时，请检查网络后重试。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'codex_account_deck', title: 'Codex Account Deck', version: '0.4.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  close() {
    if (!this.closing) this.closing = this.doClose();
    return this.closing;
  }
  async doClose() {
    this.fail(new Error('操作已结束。'));
    if (!this.ended) {
      this.child.stdin.end();
      const exited = once(this, 'closed');
      const timer = setTimeout(() => this.child.kill(), 1500);
      await exited;
      clearTimeout(timer);
    }
    this.lines.close();
  }
}
