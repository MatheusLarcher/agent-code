/**
 * O planejamento na demonstração: o Manager do plano do checkout (loja-virtual)
 * senta à cabeceira da sala de reunião e, sem teste nem chamado na TV, ela pinta
 * o resumo deste plano — falso, o main não o conhece (tvPlans.ts usa demoPlanPeek
 * no modo demonstração). As etapas andam com o loop.
 */
import type { PlanningPeekDto } from '@shared/officeApi'
import type { Conversation } from '../types'
import { DEMO_LOOP_MS, playScript, type DemoTurn } from './demoTimeline'

export const DEMO_PLAN_ID = 'demo-plan'
export const DEMO_PLAN_SLUG = 'plano-demo-checkout'

const ETAPAS = ['Mapear o checkout atual', 'Desenhar o fluxo com Pix', 'Integração com o banco', 'Testes e lançamento']

/** Dois turnos por loop: o Manager alterna entre trabalhar e esperar o usuário. */
const TURNS: DemoTurn[] = [
  {
    at: 4_000,
    user: 'Vamos planejar o checkout com Pix.',
    steps: [
      { do: 'tool', ms: 8_000, name: 'mcp__planning__plan_read', input: { slug: DEMO_PLAN_SLUG }, result: '4 etapas, 11 cards' },
      { do: 'tool', ms: 10_000, name: 'WebSearch', input: { query: 'Pix API cobrança imediata' }, result: 'bcb.gov.br — Pix: manual de padrões' },
      { do: 'tool', ms: 6_000, name: 'mcp__planning__plan_card_create', input: { tipo: 'decisao', titulo: 'QR dinâmico com vencimento' }, result: 'Card criado.' },
      { do: 'answer', text: 'Registrei a decisão do QR dinâmico. Falta escolher o banco: Itaú ou Inter?' }
    ]
  },
  {
    at: 62_000,
    user: 'Inter.',
    steps: [
      { do: 'tool', ms: 9_000, name: 'mcp__planning__plan_roteiro_set', input: { slug: DEMO_PLAN_SLUG }, result: 'Roteiro atualizado.' },
      { do: 'answer', text: 'Roteiro atualizado com a integração do Inter na etapa 3.' }
    ]
  }
]

/** A conversa de planejamento da demo (o Manager). */
export function demoPlanConversation(t: number, start: number, cycle: number, cwd: string, model: string): { conv: Conversation; busy: boolean; busySince: number | null } {
  const st = playScript(TURNS, t, start, DEMO_PLAN_ID, cycle)
  const conv: Conversation = {
    id: DEMO_PLAN_ID,
    title: 'Manager — checkout com Pix',
    cwd,
    mode: 'planning',
    planningSlug: DEMO_PLAN_SLUG,
    model,
    sdkSessionId: null,
    messages: st.messages,
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: start - 3_600_000,
    updatedAt: st.updatedAt
  }
  return { conv, busy: st.busy, busySince: st.busySince }
}

/** O resumo pintado na TV: uma etapa concluída a cada quarto do loop. */
export function demoPlanPeek(now: number): PlanningPeekDto {
  const done = Math.floor(((now % DEMO_LOOP_MS) / DEMO_LOOP_MS) * ETAPAS.length)
  return {
    titulo: 'Checkout com Pix',
    etapas: ETAPAS.map((titulo, i) => ({ titulo, status: i < done ? 'concluida' : i === done ? 'em_andamento' : 'pendente' })),
    cards: 9 + done,
    ambiguidadesAbertas: Math.max(0, 2 - done)
  }
}
