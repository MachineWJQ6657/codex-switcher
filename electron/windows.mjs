import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
export async function powershell(script, args = []) {
  // All dynamic values travel as environment data, never interpolated into shell code.
  const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, DECK_TARGET_EXE: args[0] ?? '' }
  });
  return stdout.replace(/^\uFEFF/, '').trim();
}
export async function discoverCli() {
  const root = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  try {
    const dirs = await readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(dirs.filter(x => x.isDirectory()).map(async d => {
      const file = path.join(root, d.name, 'codex.exe');
      try { return { file, updated: (await stat(file)).mtimeMs }; } catch { return null; }
    }));
    // The running desktop's backend is preferred to a leftover updater version.
    const running = await powershell("Get-Process codex -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Select-Object -Unique | ConvertTo-Json -Compress");
    const found = running ? [JSON.parse(running)].flat().find(x => candidates.some(c => c?.file === x)) : null;
    if (found) return found;
    if (candidates.filter(Boolean).length) return candidates.filter(Boolean).sort((a, b) => b.updated - a.updated)[0].file;
  } catch { /* Fall through to PATH. */ }
  try {
    const result = await powershell("(Get-Command codex.exe -ErrorAction Stop).Source");
    if (result) return result;
  } catch { /* Settings can supply an executable. */ }
  return '';
}
export async function discoverDesktop() {
  if (process.platform !== 'win32') return '';
  const result = await powershell("$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('ChatGPT','Codex') -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\' } | Select-Object -First 1 -ExpandProperty Path; if ($p) { $p } else { Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 | ForEach-Object { $a = Join-Path $_.InstallLocation 'app\\ChatGPT.exe'; if (Test-Path -LiteralPath $a) { $a } else { Join-Path $_.InstallLocation 'app\\Codex.exe' } } }");
  return result || '';
}
export async function desktopRunning(executable) {
  if (!executable || process.platform !== 'win32') return false;
  return (await powershell("$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $env:DECK_TARGET_EXE }); if ($p.Count -gt 0) { 'yes' }", [executable])) === 'yes';
}
export async function resolveDesktop(executable) {
  // Store app updates move the executable into a new versioned directory.
  if (/[/\\]OpenAI\.Codex_[^/\\]+[/\\]app[/\\](ChatGPT|Codex)\.exe$/i.test(executable)) {
    const detected = await discoverDesktop();
    if (detected) return detected;
  }
  return executable;
}
export async function closeDesktop(executable) {
  const result = await powershell(`
    $ErrorActionPreference = 'Stop'
    $inventory = @(Get-CimInstance Win32_Process)
    $roots = @($inventory | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $env:DECK_TARGET_EXE })
    if ($roots.Count -eq 0) { 'closed'; exit }
    $owned = @{}
    foreach ($p in $roots) { $owned[[int]$p.ProcessId] = $p.CreationDate }
    do {
      $added = $false
      foreach ($p in $inventory) {
        if ($owned.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -ge $owned[[int]$p.ParentProcessId] -and -not $owned.ContainsKey([int]$p.ProcessId)) {
          $owned[[int]$p.ProcessId] = $p.CreationDate; $added = $true
        }
      }
    } while ($added)
    $ps = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $env:DECK_TARGET_EXE })
    foreach ($p in $ps) { if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() } }
    $end = (Get-Date).AddSeconds(4)
    do {
      $alive = @(Get-CimInstance Win32_Process | Where-Object { $owned.ContainsKey([int]$_.ProcessId) -and $owned[[int]$_.ProcessId] -eq $_.CreationDate })
      if ($alive.Count -eq 0) { 'closed'; exit }
      Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $end)
    # Electron's window close can hide to tray. Terminate only verified target roots and their captured children.
    $fresh = @(Get-CimInstance Win32_Process)
    foreach ($p in $fresh) {
      if ($p.ExecutablePath -eq $env:DECK_TARGET_EXE -and $owned.ContainsKey([int]$p.ProcessId) -and $owned[[int]$p.ProcessId] -eq $p.CreationDate) {
        $ErrorActionPreference = 'Continue'
        $null = & taskkill.exe /PID $p.ProcessId /T /F 2>&1
        $ErrorActionPreference = 'Stop'
      }
    }
    foreach ($p in @(Get-CimInstance Win32_Process)) {
      if ($owned.ContainsKey([int]$p.ProcessId) -and $owned[[int]$p.ProcessId] -eq $p.CreationDate) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $end = (Get-Date).AddSeconds(5)
    do {
      $alive = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -eq $env:DECK_TARGET_EXE) -or ($owned.ContainsKey([int]$_.ProcessId) -and $owned[[int]$_.ProcessId] -eq $_.CreationDate) })
      if ($alive.Count -eq 0) { 'closed'; exit }
      Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $end)
    'busy'
  `, [executable]);
  if (result !== 'closed') throw new Error('目标客户端进程树未能退出，请检查权限或手动退出后重试。登录状态尚未修改。');
}
export function desktopLinks(threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('官方客户端会话 ID 无效。');
  return [`codex://threads/wake/${threadId}`, `codex://threads/${threadId}`];
}
export async function launchDesktop(executable, { threadId, home } = {}) {
  await access(executable);
  const env = { ...process.env, ...(home ? { CODEX_HOME: home } : {}) };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ACCESS_TOKEN']) delete env[key];
  const links = threadId ? desktopLinks(threadId) : [];
  const child = spawn(executable, [], { env, detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  // Windows Store activation does not reliably forward argv to the existing desktop.
  // Dispatch through the registered URI handler, which delivers OS protocol activation.
  for (const link of links) await powershell('Start-Process -FilePath $env:DECK_TARGET_EXE -ErrorAction Stop', [link]);
}
