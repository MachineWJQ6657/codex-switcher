export function installSmoke(service, defaults) {
  const now = Date.now();
  const quota = (used, weekly) => [{ id: 'codex', name: 'codex', windows: [
    { key: 'primary', used, remaining: 100 - used, minutes: 300, resetsAt: Math.floor(now / 1000) + 9600 },
    { key: 'secondary', used: weekly, remaining: 100 - weekly, minutes: 10080, resetsAt: Math.floor(now / 1000) + 321000 }
  ] }];
  const accounts = [
    { id: 'one', label: '个人主力', email: 'alex.chen@example.test', accountId: 'workspace-personal-01', plan: 'pro', isTarget: true, limits: quota(24, 43), syncedAt: now - 8000, error: null },
    { id: 'two', label: '工作室 · 产品团队', email: 'alex@studio.example.test', accountId: 'workspace-business-02', plan: 'business', isTarget: false, limits: quota(8, 19), syncedAt: now - 12000, error: null },
    { id: 'three', label: '个人备用', email: 'side.project@example.test', accountId: 'workspace-personal-03', plan: 'plus', isTarget: false, limits: quota(87, 65), syncedAt: now - 300000, error: '网络暂不可用，请稍后重试。' }
  ];
  const empty = process.env.ACCOUNT_DECK_SMOKE_EMPTY === '1';
  service.vault.data = { accounts: [], settings: defaults };
  service.snapshot = async () => ({ accounts: empty ? [] : accounts, settings: defaults, syncing: false, target: null, targetError: null, login: null,
    workflows: empty ? [] : [{ id: 'workflow-fixture', name: '产品项目自动接力', mode: 'existing', cwd: 'D:\\Projects\\sample-project', threadId: 'fixture-thread', prompt: '', accountIds: ['one', 'two'], bucketId: 'codex', status: 'monitoring', message: '任务正在运行。', accountId: 'one', turnId: null, switchCount: 0, output: '', updatedAt: now, lastCheckedAt: now, executor: 'desktop', approval: null }],
    events: [{ id: 'event', at: now, message: '已保存账号「个人主力」', type: 'info' }], canRestore: false, platform: 'win32' });
  service.dispose = async () => {};
}
