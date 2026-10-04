import { describe, expect, it } from 'vitest'
import { parseReadResult, readFileView, readRange, readSummary, RESULT_CAP } from './readView'

const disk = (n: number) => ({ kind: 'text' as const, text: Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n') + '\n', reflected: new Set<string>() })
const show = (v: ReturnType<typeof readFileView>): string[] => v.rows.map((r) => (r.kind === 'hunk' ? `[${r.label}]` : String(r.num)))

describe('readFileView', () => {
  it('leitura parcial: só as linhas lidas, com as faixas não lidas', () => {
    const v = readFileView({ disk: disk(10), offset: 4, limit: 3 })
    expect(show(v)).toEqual(['[linhas 1–3 não lidas]', '4', '5', '6', '[linhas 7–10 não lidas]'])
    expect(v.mode).toBe('plain')
    expect([v.added, v.removed]).toEqual([0, 0])
    expect(readSummary(v)).toBe('Somente leitura · leu as linhas 4–6 de 10')
  })

  it('arquivo inteiro: sem faixas, e o resumo diz quantas linhas', () => {
    const v = readFileView({ disk: disk(3), offset: null, limit: null })
    expect(show(v)).toEqual(['1', '2', '3'])
    expect(readSummary(v)).toBe('Somente leitura · leu o arquivo inteiro (3 linhas)')
  })

  it('sem limit, o Read para em 2000 linhas', () => {
    const v = readFileView({ disk: disk(2500), offset: null, limit: null })
    expect(v.rows.at(-1)).toMatchObject({ kind: 'hunk', label: 'linhas 2001–2500 não lidas' })
    expect(readRange(null, null)).toEqual({ from: 1, count: 2000, partial: false })
  })

  it('arquivo sensível nunca abre (nem pelo resultado do Read)', () => {
    const v = readFileView({ disk: disk(3), offset: null, limit: null, result: '1→SEGREDO', sensitive: true })
    expect([v.rows.length, v.note]).toEqual([0, 'Arquivo sensível: não é aberto aqui, nem o que o Agent leu dele.'])
  })

  it('fora do projeto: as linhas do próprio Read, se vieram inteiras', () => {
    const v = readFileView({ disk: { kind: 'none', reason: 'outside' }, offset: 2, limit: 2, result: '     2→b\n     3→c\n\n<system-reminder>x</system-reminder>' })
    expect(show(v)).toEqual(['[linhas 1–1 não lidas]', '2', '3', '[o resto do arquivo não foi lido]'])
    expect(v.after).toBe('b\nc')
    const cut = readFileView({ disk: { kind: 'none', reason: 'outside' }, offset: null, limit: null, result: 'x'.repeat(RESULT_CAP) })
    expect([cut.rows.length, cut.note]).toEqual([0, 'Fora da pasta do projeto: o texto lido não chegou inteiro à tela.'])
  })
})

describe('parseReadResult', () => {
  it('aceita seta e tab; para no primeiro texto que não é linha do arquivo', () => {
    expect(parseReadResult('1\tum\n2→dois\n\nlembrete')).toEqual([{ num: 1, text: 'um' }, { num: 2, text: 'dois' }])
    expect(parseReadResult('sem número')).toBeNull()
  })
})
