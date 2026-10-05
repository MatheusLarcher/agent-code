import { describe, expect, it } from 'vitest'
import {
  handoffEstimate,
  handoffEstimateDetail,
  handoffEstimateLabel,
  MAX_HANDOFF_ETAPAS,
  roteiroEtapaIds
} from './handoffEstimate'

const roteiro = [
  { id: 'requisitos', titulo: 'Levantar requisitos', estimativa: 20 },
  { id: 'pagamento', titulo: 'Integrar o pagamento', estimativa: 90 },
  { id: 'testes', titulo: 'Testar o fluxo' }
]

describe('handoffEstimate', () => {
  it('soma só as etapas que o prompt declarou, com as estimativas do roteiro atual', () => {
    expect(handoffEstimate(['pagamento', 'requisitos'], roteiro)).toEqual({
      total: 110,
      semEstimativa: 0,
      itens: [
        { id: 'pagamento', titulo: 'Integrar o pagamento', estimativa: 90 },
        { id: 'requisitos', titulo: 'Levantar requisitos', estimativa: 20 }
      ]
    })
    expect(handoffEstimate(['requisitos'], roteiro)?.total).toBe(20)
  })

  it('etapa sem estimativa, ou que sumiu do roteiro, conta como sem estimativa (a sumida fica com o id)', () => {
    const est = handoffEstimate(['requisitos', 'testes', 'removida'], roteiro)
    expect(est).toMatchObject({ total: 20, semEstimativa: 2 })
    expect(est?.itens[2]).toEqual({ id: 'removida', titulo: 'removida', estimativa: null })
  })

  it('estimativa inválida no roteiro (fora de 1..MAX, fracionária) é ignorada', () => {
    const torto = [
      { id: 'a', estimativa: 0 },
      { id: 'b', estimativa: 12.5 },
      { id: 'c', estimativa: 30 }
    ]
    expect(handoffEstimate(['a', 'b', 'c'], torto)).toMatchObject({ total: 30, semEstimativa: 2 })
  })

  it('prompt sem etapas declaradas (antigo): null', () => {
    expect(handoffEstimate(undefined, roteiro)).toBeNull()
    expect(handoffEstimate([], roteiro)).toBeNull()
  })
})

describe('handoffEstimateLabel e handoffEstimateDetail', () => {
  it('total formatado e a contagem de etapas', () => {
    expect(handoffEstimateLabel(handoffEstimate(['requisitos', 'pagamento'], roteiro))).toBe('Total estimado: 1 h 50 min · 2 etapas')
    expect(handoffEstimateLabel(handoffEstimate(['requisitos'], roteiro))).toBe('Total estimado: 20 min · 1 etapa')
  })

  it('avisa as etapas sem estimativa', () => {
    expect(handoffEstimateLabel(handoffEstimate(['pagamento', 'testes'], roteiro))).toBe(
      'Total estimado: 1 h 30 min · 2 etapas, 1 sem estimativa'
    )
    expect(handoffEstimateLabel(handoffEstimate(['testes'], roteiro))).toBe('1 etapa, nenhuma com estimativa')
  })

  it('sem etapas declaradas', () => {
    expect(handoffEstimateLabel(null)).toBe('sem etapas declaradas')
    expect(handoffEstimateDetail(null)).toMatch(/sem entregas e sem prazo/)
  })

  it('a dica lista etapa → estimativa, uma por linha', () => {
    expect(handoffEstimateDetail(handoffEstimate(['pagamento', 'testes'], roteiro))).toBe(
      'Integrar o pagamento: 1 h 30 min\nTestar o fluxo: sem estimativa'
    )
  })
})

describe('roteiroEtapaIds (etapas do rascunho automático)', () => {
  it('todas as etapas do roteiro, na ordem, até o teto por prompt', () => {
    expect(roteiroEtapaIds(roteiro)).toEqual(['requisitos', 'pagamento', 'testes'])
    const grande = Array.from({ length: MAX_HANDOFF_ETAPAS + 5 }, (_, i) => ({ id: `e-${i}` }))
    expect(roteiroEtapaIds(grande)).toHaveLength(MAX_HANDOFF_ETAPAS)
    expect(roteiroEtapaIds([])).toEqual([])
  })
})
