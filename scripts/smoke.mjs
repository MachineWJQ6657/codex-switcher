import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('.');
const output = path.join(root, '.test-output');
await mkdir(output, { recursive: true });
for (const empty of [false, true]) {
  const env = { ...process.env, ACCOUNT_DECK_SMOKE: '1', ACCOUNT_DECK_SMOKE_EMPTY: empty ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ACCOUNT_DECK_DEV_URL;
  const app = await electron.launch({ executablePath, args: [root, '--disable-gpu', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], env, timeout: 30000 });
  const errors = [];
  try {
    const page = await app.firstWindow({ timeout: 30000 }); page.on('pageerror', e => errors.push(e.message));
    // Windows may stop painting an entirely hidden, non-scrolling window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.getByRole('heading', { name: '账号总览' }).waitFor();
    assert.equal(await page.locator('.account-card').count(), empty ? 0 : 3);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const snap = await page.evaluate(async () => window.deck.snapshot());
    assert.ok(snap.ok);
    await page.screenshot({ path: path.join(output, empty ? 'empty.png' : 'accounts.png'), fullPage: true });
    if (!empty) {
      await page.getByRole('button', { name: '商业', exact: true }).click();
      assert.equal(await page.locator('.account-card').count(), 1);
      await page.getByRole('button', { name: '全部账号' }).click();
      await page.getByRole('textbox', { name: '搜索账号' }).fill('side.project');
      assert.equal(await page.locator('.account-card').count(), 1);
      await page.getByRole('textbox', { name: '搜索账号' }).fill('not-an-account');
      await page.getByRole('heading', { name: '没有找到匹配的账号' }).waitFor();
      await page.getByRole('button', { name: '清除筛选' }).click();
      await page.getByRole('button', { name: '个人主力的更多操作' }).click();
      await page.getByRole('button', { name: '编辑备注' }).click();
      await page.getByRole('textbox', { name: '账号备注' }).fill('测试备注');
      await page.getByRole('button', { name: '取消编辑' }).click();
    }
    await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
    await page.getByRole('dialog', { name: '添加账号' }).waitFor();
    await page.getByRole('button', { name: '设备代码', exact: true }).click();
    await page.screenshot({ path: path.join(output, empty ? 'empty-add.png' : 'add-account.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭对话框' }).click();
    await page.getByRole('button', { name: '自动工作流', exact: true }).click();
    await page.getByRole('heading', { name: '自动工作流' }).waitFor();
    await page.screenshot({ path: path.join(output, empty ? 'workflow-empty.png' : 'workflows.png'), fullPage: true });
    await page.getByRole('button', { name: '创建工作流', exact: true }).click();
    await page.getByRole('textbox', { name: '工作流名称' }).fill('界面测试任务');
    await page.getByRole('combobox', { name: '工作流运行方式' }).selectOption('new');
    await page.getByRole('textbox', { name: '项目目录' }).fill('D:\\Projects\\sample');
    await page.getByRole('textbox', { name: '任务内容' }).fill('完成项目中剩余的任务，并运行检查。');
    await page.screenshot({ path: path.join(output, empty ? 'workflow-form-empty.png' : 'workflow-form.png'), fullPage: true });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '客户端设置', exact: true }).click();
    await page.getByRole('heading', { name: '本机连接' }).waitFor();
    await page.getByRole('switch', { name: '自动同步额度' }).click();
    assert.equal(await page.getByRole('switch', { name: '自动同步额度' }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.getByRole('switch', { name: '低资源模式' }).getAttribute('aria-checked'), 'true');
    await page.screenshot({ path: path.join(output, empty ? 'empty-settings.png' : 'settings.png'), fullPage: true });
    await page.getByRole('button', { name: '操作记录', exact: true }).click();
    await page.getByRole('heading', { name: '最近操作' }).waitFor();
    await page.getByRole('button', { name: '使用说明' }).click();
    await page.getByRole('heading', { name: '关于账号切换' }).waitFor();
    await page.getByRole('button', { name: '关闭对话框' }).click();
    assert.deepEqual(errors, []);
    console.log(`Electron UI ${empty ? 'empty' : 'populated'}: PASS (filters, dialogs, settings, isolation, no page errors)`);
  } finally { await app.close(); }
}
