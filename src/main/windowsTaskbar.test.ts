import { describe, it, expect } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { hideChromeWindowFromTaskbar } from './windowsTaskbar'

const isWindows = process.platform === 'win32'

/** Read back GWL_EXSTYLE for the (single, real) top-level window of `pid` — `null`
 *  when no such window exists yet (NOT the same as a style value of 0). */
function readExStyle(pid: number): Promise<number | null> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AgentCodeWin32Test {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@
$targetPid = ${pid}
$found = $false
$result = 0
[AgentCodeWin32Test]::EnumWindows({
  param($hWnd, $lparam)
  $procId = 0
  [AgentCodeWin32Test]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
  if ($procId -eq $targetPid -and [AgentCodeWin32Test]::IsWindowVisible($hWnd) -and [AgentCodeWin32Test]::GetParent($hWnd) -eq [IntPtr]::Zero) {
    $script:found = $true
    $script:result = [AgentCodeWin32Test]::GetWindowLong($hWnd, -20)
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($found) { Write-Output $result } else { Write-Output 'NOTFOUND' }
`.trim()
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (_err, stdout) => {
      const out = stdout.trim()
      if (out === 'NOTFOUND') return resolve(null)
      const n = Number.parseInt(out, 10)
      resolve(Number.isNaN(n) ? null : n)
    })
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `readExStyle` until the window actually exists (Add-Type compilation +
 *  window creation can take a variable amount of time, especially under load —
 *  a fixed sleep here was flaky) or the timeout elapses. */
async function waitForWindow(pid: number, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const style = await readExStyle(pid)
    if (style !== null) return style
    if (Date.now() > deadline) throw new Error(`Janela do processo ${pid} não apareceu em ${timeoutMs}ms`)
    await delay(200)
  }
}

/**
 * Spawn a throwaway WinForms window we fully own — NOT notepad.exe: Windows 11's
 * Notepad reuses a single shared window/instance across launches, so killing the
 * spawned process doesn't reliably close the real window (this bit us once: an
 * earlier version of this test left a real Notepad window permanently hidden from
 * the taskbar/Alt-Tab, since the actual owning process outlived the one we killed).
 * A WinForms window hosted directly in our own powershell.exe process has no such
 * ambiguity — killing that one process always closes exactly this one window.
 */
function spawnTestWindow(marker: string): ChildProcess {
  const script = `
# marker:${marker}
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '${marker}'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-32000, -32000)
$form.Show()
[System.Windows.Forms.Application]::Run($form)
`.trim()
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
}

describe.skipIf(!isWindows)('hideChromeWindowFromTaskbar', () => {
  it('adiciona WS_EX_TOOLWINDOW na janela real do processo alvo (o que de fato tira da taskbar)', async () => {
    const marker = `agent-code-taskbar-test-${Date.now()}`
    const proc = spawnTestWindow(marker)
    try {
      expect(proc.pid).toBeTruthy()

      const before = await waitForWindow(proc.pid!) // polls instead of a fixed sleep — flaky under load otherwise
      // eslint-disable-next-line no-bitwise
      expect((before & 0x80) === 0).toBe(true) // WS_EX_TOOLWINDOW ainda não setado

      // O marcador está no próprio texto do script passado a powershell.exe —
      // aparece no CommandLine do processo, único o bastante para o teste.
      await hideChromeWindowFromTaskbar(marker)

      const after = await readExStyle(proc.pid!)
      expect(after).not.toBeNull()
      // WS_EX_TOOLWINDOW é o que importa: o Explorer exclui tool windows da
      // taskbar/Alt-Tab independente do WS_EX_APPWINDOW (que empiricamente não
      // "cola" numa janela já visível — por isso não testamos esse bit aqui).
      // eslint-disable-next-line no-bitwise
      expect((after! & 0x80) !== 0).toBe(true)
    } finally {
      proc.kill() // this process is the SOLE owner of its window — always closes it
    }
  }, 30000)

  it('não faz nada (não rejeita) quando não há processo casando com o marcador', async () => {
    await expect(hideChromeWindowFromTaskbar(`agent-code-marker-inexistente-${Date.now()}`)).resolves.toBeUndefined()
  }, 20000)
})

describe('hideChromeWindowFromTaskbar — fora do Windows', () => {
  it('resolve imediatamente sem marcador', async () => {
    await expect(hideChromeWindowFromTaskbar('')).resolves.toBeUndefined()
  })
})
