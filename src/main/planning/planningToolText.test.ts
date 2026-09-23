// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PlanCard } from './planningModel'
import type { OpenedPlan } from './planningStore'
import { cardHeader, cardListLine, describePlan } from './planningToolText'

const card: PlanCard = {
  id: 'dec-banco',
  tipo: 'decisao',
  titulo: 'Decisão do Banco',
  etapa: 'dados',
  links: ['req-login'],
  fonte: 'https://www.postgresql.org/docs/',
  rev: 3,
  corpo: 'Postgres porque\n  já roda no servidor.\n'
}

const plan = (cards: PlanCard[]): OpenedPlan => ({
  slug: 'checkout',
  roteiro: { titulo: 'Checkout novo', rev: 1, etapas: [{ id: 'dados', titulo: 'Modelar dados', status: 'pendente' }] },
  cards,
  layout: {} as OpenedPlan['layout'],
  invalid: []
})

describe('cardListLine', () => {
  it('põe o título em destaque, no formato [[Título]], e o id e o tipo ao lado', () => {
    expect(cardListLine(card)).toBe(
      '[[Decisão do Banco]] (id dec-banco, decisao) · etapa dados · links req-login · fonte https://www.postgresql.org/docs/ · rev 3'
    )
  })

  it('não muda o cabeçalho das demais respostas (criado/atualizado/conflito)', () => {
    expect(cardHeader(card)).toBe(
      'dec-banco [decisao] Decisão do Banco · etapa dados · links req-login · fonte https://www.postgresql.org/docs/ · rev 3'
    )
  })
})

describe('describePlan', () => {
  it('lista os cards pelo [[Título]] e explica que é o nome que o usuário cita', () => {
    const out = describePlan(plan([card]))
    expect(out).toContain('Cards (1) — [[Título]] é o nome com que o usuário cita o card; as ferramentas pedem o id:')
    expect(out).toContain('  - [[Decisão do Banco]] (id dec-banco, decisao) · etapa dados · links req-login')
    expect(out).toMatch(/rev 3 — Postgres porque já roda no servidor\.$/m)
  })

  it('sem cards, diz que não há nenhum', () => {
    expect(describePlan(plan([]))).toMatch(/^Cards: nenhum\.$/m)
  })
})
