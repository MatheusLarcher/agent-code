import { describe, expect, it } from 'vitest'
import {
  dayLabel,
  daySummary,
  etapaText,
  filterEnvios,
  groupByDay,
  histKind,
  histMeta,
  projectName,
  resumeText,
  sobreChip,
  sobreText,
  statusOf,
  trackOf,
  verdictOf
} from './scrumPanelText'
import { at, decisao, envio, histItem as item, NOW } from './scrumPanelFixtures'

describe('os textos do painel do Scrum Master', () => {
  it('status, etapa e filtro do Agora', () => {
    expect(statusOf(envio())).toEqual({ cls: 'atrasado', text: 'atrasado · 2,1× do prazo' })
    expect(statusOf(envio({ estado: 'parado', vezes: 3 }))).toEqual({ cls: 'parado', text: 'parado pelo Scrum · 3× do prazo' })
    expect(statusOf(envio({ estado: 'no-prazo', vezes: 0.6 }))).toEqual({ cls: 'ok', text: 'no prazo · 0,6×' })
    expect(statusOf(envio({ estado: 'no-prazo', vezes: null })).text).toBe('no prazo')
    expect(etapaText(envio())).toBe('Etapa 3 de 5 — Ações')
    expect(etapaText(envio({ etapaN: null }))).toBe('Ações')
    const list = [envio({ envioId: 'a', estado: 'parado' }), envio({ envioId: 'b' }), envio({ envioId: 'c', estado: 'no-prazo' })]
    expect(filterEnvios(list, 'parados').map((e) => e.envioId)).toEqual(['a'])
    expect(filterEnvios(list, 'atrasados').map((e) => e.envioId)).toEqual(['b'])
    expect(filterEnvios(list, 'todos')).toHaveLength(3)
  })

  it('a trilha acende os marcos passados e o 300% do envio parado', () => {
    const t = trackOf(envio())
    expect(t.marks.map((m) => [m.pct, m.hit])).toEqual([
      [0, false],
      [100, true],
      [150, true],
      [200, true],
      [300, false]
    ])
    expect(t.now).toEqual({ left: 70, label: '84 min / 40 min' })
    const p = trackOf(envio({ estado: 'parado', vezes: 3.2, marcos: [150, 200, 300] }))
    expect(p.marks[4]).toMatchObject({ hit: true, bad: true, glyph: '⏹', left: 100 })
    expect(p.now?.left).toBe(100)
    expect(trackOf(envio({ vezes: null, prazoMin: null })).now).toBeNull()
  })

  it('veredito, verbo do histórico e meta', () => {
    expect(verdictOf('desvio', 'laco-de-teste')).toEqual({ cls: 'desvio', text: 'DESVIO · laço de teste' })
    expect(verdictOf('justificado', null)?.text).toBe('JUSTIFICADO')
    expect(verdictOf(null, null)).toBeNull()
    expect(histKind('parou')).toMatchObject({ verbo: 'Cortou', ico: '✂', corte: true })
    expect(histKind('interrompeu')).toMatchObject({ verbo: 'Interrompeu', ligacao: 'agente travado em', corte: true })
    expect(histKind('avisou').verbo).toBe('Avisou você')
    expect(histMeta(decisao())).toEqual({ antes: '12:48 · marco 300%', depois: '96 min de 30 min · avisou você' })
    expect(histMeta(decisao({ tipo: 'interrompeu', marco: 'travado', declaradoMin: 60, decorridoMs: 74 * 60_000 })).depois).toBe(
      'declarou 60 min, passou 74 min sem chamar ferramenta · avisou você'
    )
    expect(histMeta(decisao({ tipo: 'cobrou', marco: 150 })).depois).toBe('96 min de 30 min')
  })

  it('o "Sobre:" da conversa e o chip do compositor', () => {
    expect(sobreText(decisao())).toBe('Cortou Funil de vendas · crm · 12:48')
    expect(sobreChip(decisao(), null)).toBe('corte em crm')
    expect(sobreChip(decisao({ tipo: 'cobrou' }), null)).toBe('cobrança em crm')
    expect(sobreChip(undefined, 'C:\\p\\loja')).toBe('decisão em loja')
    expect(projectName(null)).toBe('sem projeto')
    expect(projectName('/home/u/mapa/')).toBe('mapa')
  })

  it('agrupa por dia (Hoje, Ontem, a data) e resume o dia fechado', () => {
    const items = [item({ id: 'a', at: at(13, 0) }), item({ id: 'b', at: at(9, 0) }), item({ id: 'c', at: at(18, 0, 1), tipo: 'cobrou' }), item({ id: 'd', at: at(10, 0, 3), tipo: 'deixou-seguir', veredito: 'justificado' })]
    const days = groupByDay(items, NOW)
    expect(days.map((d) => [d.label, d.items.length])).toEqual([
      ['Hoje', 2],
      ['Ontem', 1],
      ['08/10/2026', 1]
    ])
    expect(dayLabel(at(0, 1), NOW)).toBe('Hoje')
    expect(daySummary(items)).toBe('1 cobrança · 1 justificada · 2 cortes')
  })

  it('o texto do "Retomar com o aviso"', () => {
    expect(resumeText(envio({ etapaN: 2, paradoMotivo: 'fugiu do escopo.' }))).toBe(
      'Pode retomar a etapa 2 de onde parou. O motivo da parada foi: fugiu do escopo. Leve o aviso em conta, diga em uma linha o que falta e siga.'
    )
  })
})
