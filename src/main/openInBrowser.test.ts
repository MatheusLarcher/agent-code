import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { buildCommand, isLocalWebFile, parseRegValue } from './openInBrowser'

describe('openInBrowser', () => {
  it('reconhece só arquivo web local', () => {
    expect(isLocalWebFile('file:///C:/x/mockup.html')).toBe(true)
    expect(isLocalWebFile('file:///C:/x/mockup.HTM#tela')).toBe(true)
    expect(isLocalWebFile('file:///C:/x/notas.md')).toBe(false)
    expect(isLocalWebFile('https://site.com/a.html')).toBe(false)
  })

  it('lê o valor do reg query (inclusive com rótulo acentuado)', () => {
    const out = '\r\nHKEY_CLASSES_ROOT\\ChromeHTML\\shell\\open\\command\r\n    (padr�o)    REG_SZ    "C:\\Chrome\\chrome.exe" --single-argument %1\r\n'
    expect(parseRegValue(out)).toBe('"C:\\Chrome\\chrome.exe" --single-argument %1')
    expect(parseRegValue('nada')).toBeNull()
  })

  it('troca o %1 pela url e acrescenta quando não há marcador', () => {
    const url = 'file:///C:/a b/m.html'
    expect(buildCommand('"C:\\Chrome\\chrome.exe" --single-argument %1', url)).toEqual({
      exe: 'C:\\Chrome\\chrome.exe',
      args: ['--single-argument', url]
    })
    expect(buildCommand('"C:\\Edge\\msedge.exe" --single-argument "%1"', url)?.args).toEqual(['--single-argument', url])
    expect(buildCommand('C:\\ff\\firefox.exe -osint -url', url)?.args).toEqual(['-osint', '-url', url])
  })
})
