/**
 * As varreduras do fim da conversa do app Código (useCodeApp.ts): o bloco ao
 * vivo, o último arquivo tocado e a última leitura. Só a trilha principal — a
 * ferramenta de subagente gravada na conversa não conta nem gasta a varredura.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../../types'
import { SCAN_MAX } from './codeModel'
import { normalizePath } from './pathGuard'
import type { LiveBlock } from './stitch'
import { lastReadOf, latestTouch, pickLive } from './useCodeApp'

const FILE = 'C:\\proj\\src\\a.ts'
const OTHER = 'C:\\proj\\src\\b.ts'
const ok = { isError: false, text: '1\tconst a = 1' }
const tool = (id: string, name: string, file: string, parent: string | null = null): UIMessage =>
  ({ kind: 'tool-use', id, name, input: { file_path: file }, parentToolUseId: parent, result: ok }) as UIMessage
const sub = (id: string, name = 'Read', file = OTHER): UIMessage => tool(id, name, file, 'task')
const subs = (n: number): UIMessage[] => Array.from({ length: n }, (_, i) => sub(`s${i}`))
const user = { kind: 'user', id: 'u1', text: 'pedido' } as UIMessage
const block = (toolUseId: string): LiveBlock => ({ toolUseId, name: 'Write', filePath: FILE, lines: ['x'], totalLines: 1, done: false, at: Date.now() })

describe('useCodeApp — só a trilha principal nas varreduras', () => {
  it('pickLive: o tool-use principal que já chegou continua visto mesmo com muitas ações de subagente depois', () => {
    expect(pickLive([block('w1')], [user, tool('w1', 'Write', FILE), ...subs(SCAN_MAX)], true)).toBeNull()
    // Sem o tool-use final, o bloco ainda é o ao vivo.
    expect(pickLive([block('w1')], [user, ...subs(3)], true)?.toolUseId).toBe('w1')
  })

  it('lastReadOf: a leitura do subagente não é a do turno; a principal segue achada atrás das dele', () => {
    const key = normalizePath(FILE)
    expect(lastReadOf([user, sub('s1', 'Read', FILE)], key)).toBeNull()
    const main = tool('r1', 'Read', FILE)
    expect(lastReadOf([user, main, sub('s1', 'Read', FILE), ...subs(SCAN_MAX)], key)).toBe(main)
  })

  it('latestTouch: o arquivo que o subagente leu ou escreveu não vira a aba seguida', () => {
    expect(latestTouch([user, tool('w1', 'Write', FILE), sub('s1', 'Read', OTHER), sub('s2', 'Write', OTHER)])).toEqual({
      key: normalizePath(FILE),
      read: false
    })
    expect(latestTouch([user, tool('w1', 'Write', FILE), ...subs(SCAN_MAX)])?.key).toBe(normalizePath(FILE))
  })
})
