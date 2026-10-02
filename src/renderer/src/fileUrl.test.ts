import { describe, expect, it } from 'vitest'
import { fileUrl } from './fileUrl'

describe('fileUrl: caminho local → file:///', () => {
  it('Windows: barras invertidas viram /', () => {
    expect(fileUrl('C:\\a\\b c.png')).toBe('file:///C:/a/b c.png')
    expect(fileUrl('C:/proj/src/App.tsx')).toBe('file:///C:/proj/src/App.tsx')
  })

  it('remove TODAS as barras do começo (nada de file://// )', () => {
    expect(fileUrl('/home/u/icon.svg')).toBe('file:///home/u/icon.svg')
    expect(fileUrl('//srv/share/a.txt')).toBe('file:///srv/share/a.txt')
    expect(fileUrl('\\\\srv\\share\\a.txt')).toBe('file:///srv/share/a.txt')
  })
})
