import { execFile } from 'node:child_process'

/** Escape a value for embedding in a single-quoted PowerShell string literal. */
function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Windows only, best-effort: hides every top-level window of the (real, headed)
 * Chrome process behind the embedded browser preview from the taskbar/Alt-Tab
 * switcher. It's parked off-screen already, but Windows still lists any
 * top-level window in the taskbar regardless of screen position, and Chrome has
 * no CLI flag for this.
 *
 * Windows only "commits" a WS_EX_APPWINDOW/WS_EX_TOOLWINDOW change on an
 * already-visible window at a hide/show transition — `SetWindowLong` alone
 * doesn't stick (confirmed empirically; see windowsTaskbar.test.ts). So this
 * briefly hides then re-shows the window (`SW_SHOWNA`, which doesn't activate/
 * steal focus) around the style change. Call this BEFORE any tab/screencast
 * exists on the window — safe here since it's off-screen and nothing is
 * capturing it yet, but hiding a window that's mid-capture could stall frames.
 *
 * The process is identified by `userDataDirMarker` (our unique `--user-data-dir`
 * path) rather than a PID, since Playwright's `Browser` (from
 * `launchPersistentContext`) doesn't expose the OS process — only
 * `BrowserServer`/`ElectronApplication` do.
 *
 * Implemented by shelling out to PowerShell (built into Windows, no native/npm
 * dependency) to call user32 directly. Retries for a few seconds since the
 * window may not exist yet right when the process spawns. Resolves without
 * effect on any non-Windows platform, or if anything goes wrong — this is
 * cosmetic and must never fail the caller's actual browser launch.
 */
export function hideChromeWindowFromTaskbar(userDataDirMarker: string): Promise<void> {
  if (process.platform !== 'win32' || !userDataDirMarker.trim()) return Promise.resolve()

  const marker = psQuote(userDataDirMarker)
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentCodeWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$marker = '${marker}'
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x80
$SW_HIDE = 0
$SW_SHOWNA = 8 # like SW_SHOW but doesn't activate/steal focus

for ($attempt = 0; $attempt -lt 15; $attempt++) {
  $targetPids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) } | ForEach-Object {
    [void]$targetPids.Add([uint32]$_.ProcessId)
  }

  $hwnds = New-Object System.Collections.Generic.List[IntPtr]
  if ($targetPids.Count -gt 0) {
    [AgentCodeWin32]::EnumWindows({
      param($hWnd, $lparam)
      $procId = 0
      [AgentCodeWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
      if ($targetPids.Contains([uint32]$procId) -and [AgentCodeWin32]::IsWindowVisible($hWnd) -and [AgentCodeWin32]::GetParent($hWnd) -eq [IntPtr]::Zero) {
        $hwnds.Add($hWnd)
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  }

  if ($hwnds.Count -gt 0) {
    foreach ($h in $hwnds) {
      # WS_EX_TOOLWINDOW alone is enough — Explorer excludes tool windows from the
      # taskbar/Alt-Tab regardless of WS_EX_APPWINDOW (confirmed empirically: that
      # bit doesn't reliably clear on an already-visible window, but the window is
      # excluded from the taskbar either way once TOOLWINDOW is set).
      # Windows only "commits" this kind of change at a show/hide transition —
      # SetWindowLong alone doesn't stick. SW_SHOWNA re-shows without activating,
      # so the (off-screen, already-invisible-to-the-user) window never steals focus.
      [AgentCodeWin32]::ShowWindow($h, $SW_HIDE) | Out-Null
      $ex = [AgentCodeWin32]::GetWindowLong($h, $GWL_EXSTYLE)
      [AgentCodeWin32]::SetWindowLong($h, $GWL_EXSTYLE, ($ex -bor $WS_EX_TOOLWINDOW)) | Out-Null
      [AgentCodeWin32]::ShowWindow($h, $SW_SHOWNA) | Out-Null
    }
    break
  }
  Start-Sleep -Milliseconds 300
}
`.trim()

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 15_000 },
      () => resolve() // best-effort — a failure here never affects the caller
    )
  })
}
