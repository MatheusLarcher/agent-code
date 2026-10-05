// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// AgentSession.dispose não emite `result`/`error` nem expira as permissões. A
// sessão SUBSTITUÍDA (troca de modelo/config, mcp-model) some no meio do turno
// sem que o acompanhamento saiba: o turno ficaria "rodando" e a varredura somaria
// tempo ATIVO a cada passada. Todo descarte dela em index.ts avisa o tracker.

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

/** A próxima linha com código depois de `index` (pula vazias e comentários). */
function nextCodeLine(lines: readonly string[], index: number): string {
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line && !line.startsWith('//')) return line
  }
  return ''
}

describe('index.ts: sessão substituída avisa o acompanhamento', () => {
  it('replaced.dispose() e previous.dispose() são seguidos de handoffTracker.sessionEnded(convId)', () => {
    const lines = source.split(/\r?\n/)
    const sites = lines.flatMap((line, index) => (/^\s*(replaced|previous)\.dispose\(\)/.test(line) ? [index] : []))
    expect(sites).toHaveLength(2)
    for (const index of sites) {
      expect(`${lines[index].trim()} → ${nextCodeLine(lines, index)}`).toBe(
        `${lines[index].trim()} → handoffTracker.sessionEnded(convId)`
      )
    }
  })
})
