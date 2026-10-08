/**
 * O resumo da aba Implantação pela regra única de etapas (shared/stepProgress):
 * N/M são as etapas prontas do PLANO (todos os envios dele), não as do envio
 * corrente; o status é o do envio de agora (planEnvioAtual: o lote mais novo,
 * o status mais vivo/grave).
 */
import { describe, expect, it, vi } from 'vitest'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { planProgress } from '@shared/stepProgress'
import type { DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { deploySummary, type DeployPlan } from './TvDeploy'

const at = (min: number): string => new Date(Date.UTC(2026, 9, 5, 12, min)).toISOString()
const PLAN: DeployPlan = { slug: 'checkout', cwd: 'C:\\GitHub\\loja', title: 'Checkout com Pix' }
const center = (envios: HandoffEnvio[]): DeliveryCenterValue => ({ envios, error: null, correct: vi.fn(), openConversation: vi.fn() })
const ours = (over: Partial<HandoffEnvio>): HandoffEnvio => envio({ projectCwd: 'c:/github/loja', ...over })

describe('aba Implantação: as contas do plano (planProgress)', () => {
  it('conta as etapas prontas de todos os envios do plano, não só as do envio corrente', () => {
    const envios = [
      ours({ id: 'p1', ordem: 1, status: 'concluida', enviadoEm: at(1), entregas: [entrega({ etapaId: 'a', status: 'concluida' }), entrega({ etapaId: 'b', ordem: 2, status: 'concluida' })] }),
      ours({ id: 'p2', ordem: 2, status: 'em_execucao', enviadoEm: at(5), entregas: [entrega({ etapaId: 'c', status: 'em_andamento' }), entrega({ etapaId: 'd', ordem: 2 })] })
    ]
    expect(deploySummary(center(envios), PLAN)).toEqual({ label: 'Implantação · 2/4 · em execução', status: 'em_execucao' })
    const { prontas, total } = planProgress(envios)
    expect([prontas, total]).toEqual([2, 4])
  })

  it('o status é o do envio de agora: o lote mais novo manda, e dentro dele o mais vivo/grave', () => {
    const envios = [
      ours({ id: 'velho', loteId: 'hl-1', status: 'falhou', criadoEm: at(0), enviadoEm: at(0), entregas: [entrega({ etapaId: 'a', status: 'incompleta' })] }),
      ours({ id: 'n1', loteId: 'hl-2', ordem: 1, status: 'enviado', criadoEm: at(9), enviadoEm: at(9), entregas: [entrega({ etapaId: 'a' })] }),
      ours({ id: 'n2', loteId: 'hl-2', ordem: 2, status: 'na_fila', criadoEm: at(9), enviadoEm: null, entregas: [entrega({ etapaId: 'b' })] })
    ]
    // A reenviada "a" vale pela entrega mais nova (na fila de novo), não pela trincada do lote antigo.
    expect(deploySummary(center(envios), PLAN)).toEqual({ label: 'Implantação · 0/2 · enviado', status: 'enviado' })
  })
})
