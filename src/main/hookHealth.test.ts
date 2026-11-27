import { describe, expect, it } from 'vitest'
import { findBrokenHooks, hookNotice, hookTarget } from './hookHealth'

const EXE = 'C:\\Users\\X\\AppData\\Local\\Codenotch\\codenotch-hook.exe'
const settings = (hooks: Record<string, string[]>): string =>
  JSON.stringify({
    hooks: Object.fromEntries(
      Object.entries(hooks).map(([event, cmds]) => [event, [{ hooks: cmds.map((command) => ({ type: 'command', command })) }]])
    )
  })
const fakeFs = (present: string[]) => (path: string) => present.includes(path)

describe('findBrokenHooks', () => {
  it('programa que sumiu: um problema com todos os eventos', () => {
    const cmd = `"${EXE}" running`
    const text = settings({ PreToolUse: [cmd], Stop: [cmd], SessionStart: [cmd] })
    expect(findBrokenHooks(text, fakeFs([]))).toEqual([{ path: EXE, events: ['PreToolUse', 'Stop', 'SessionStart'] }])
  })

  it('programa presente: nada', () => {
    expect(findBrokenHooks(settings({ Stop: [`"${EXE}" running`] }), fakeFs([EXE]))).toEqual([])
  })

  it('powershell -File com script que não existe: problema no script', () => {
    const script = 'C:/Users/X/.claude/hooks/ram-guard.ps1'
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File ${script}`
    expect(findBrokenHooks(settings({ PreToolUse: [cmd] }), fakeFs([]))).toEqual([{ path: script, events: ['PreToolUse'] }])
    expect(findBrokenHooks(settings({ PreToolUse: [cmd] }), fakeFs([script]))).toEqual([])
  })

  it('comando do PATH e código inline não contam como faltando', () => {
    const text = settings({ Stop: ['node -e "console.log(1)"', 'codenotch-hook running', 'powershell -Command Write-Host oi'] })
    expect(findBrokenHooks(text, fakeFs([]))).toEqual([])
  })

  it('expande ~ e %VAR%; variável desconhecida não acusa', () => {
    const env = { USERPROFILE: 'C:\\Users\\X' }
    const text = settings({ Stop: ['node ~/h.js', 'node %USERPROFILE%\\h.js', 'node %NAO_EXISTE%\\h.js'] })
    expect(findBrokenHooks(text, fakeFs([]), env, '/home/x').map((p) => p.path)).toEqual(['/home/x/h.js', 'C:\\Users\\X\\h.js'])
  })

  it('JSON quebrado ou sem hooks: nada, sem lançar', () => {
    expect(findBrokenHooks('{ não é json', fakeFs([]))).toEqual([])
    expect(findBrokenHooks('{}', fakeFs([]))).toEqual([])
    expect(findBrokenHooks('null', fakeFs([]))).toEqual([])
    expect(findBrokenHooks(JSON.stringify({ hooks: { Stop: 'x', Pre: [null, { hooks: [null, {}] }] } }), fakeFs([]))).toEqual([])
  })
})

describe('hookTarget', () => {
  it('cmd /c e node com flags', () => {
    expect(hookTarget('cmd /c C:\\x.bat')).toBeNull()
    expect(hookTarget('node --no-warnings C:/h.js')).toBe('C:/h.js')
  })
})

describe('hookNotice', () => {
  it('diz qual programa, onde está configurado e o que fazer', () => {
    const { title, body } = hookNotice([{ path: EXE, events: ['Stop'] }], 'C:\\Users\\X\\.claude\\settings.json')
    expect(title).toBe('Um programa ligado ao Claude sumiu')
    expect(body).toContain('"codenotch-hook.exe"')
    expect(body).toContain('C:\\Users\\X\\.claude\\settings.json')
    expect(body).toContain('Reinstale o programa ou apague')
  })
})
