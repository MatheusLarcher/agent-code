// @vitest-environment node
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import { entrega, envio } from '../handoffTracking/handoffTestKit'
import { createPlan, openPlan, saveRoteiro } from '../planning/planningStore'
import { planEtapasProgress, servePlanningRoute, type PlanningBridgeCtx } from './planningBridge'

// O "N/M etapas" da lista de planos do celular: com envios, o progresso da
// IMPLEMENTAÇÃO pela posição no plano (planProgress); sem, a ESPECIFICAÇÃO do
// roteiro (roteiroProgress). Direto na rota, com os envios injetados.

let cwd = ''

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-bridge-progress-'))
  await createPlan(cwd, 'plano-a', 'Checkout')
  const rev = (await openPlan(cwd, 'plano-a')).roteiro.rev
  // Especificação: 3 de 4 etapas "concluida" no roteiro (especificadas, não prontas).
  await saveRoteiro(
    cwd,
    'plano-a',
    {
      titulo: 'Checkout',
      etapas: [
        { id: 'base', titulo: 'Base', status: 'concluida' },
        { id: 'pix', titulo: 'Pix', status: 'concluida' },
        { id: 'tela', titulo: 'Tela', status: 'concluida' },
        { id: 'aceite', titulo: 'Aceite', status: 'pendente' }
      ]
    },
    rev
  )
  await createPlan(cwd, 'plano-b', 'Login')
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

async function list(envios: PlanningBridgeCtx['envios']): Promise<any> {
  let body = ''
  let status = 0
  const res = {
    writeHead: (s: number) => {
      status = s
      return res
    },
    end: (b: string) => {
      body = b
    }
  } as unknown as ServerResponse
  const url = new URL(`http://pc/api/planning/list?cwd=${encodeURIComponent(cwd)}`)
  const ctx: PlanningBridgeCtx = { state: { conversations: [], projects: [cwd] }, isDirectory: async () => true, envios }
  await servePlanningRoute('/api/planning/list', { method: 'GET' } as IncomingMessage, url, res, ctx)
  expect(status).toBe(200)
  return JSON.parse(body)
}

const etapas = (out: any): Record<string, unknown> => Object.fromEntries(out.plans.map((p: any) => [p.slug, p.etapas]))

describe('GET /api/planning/list — "N/M etapas"', () => {
  it('plano com envios: prontas de total pela posição no plano (o roteiro + as enviadas fora dele)', async () => {
    const parte1 = envio({
      id: 'e1',
      projectCwd: cwd,
      planSlug: 'plano-a',
      entregas: [entrega({ etapaId: 'base', status: 'concluida' }), entrega({ etapaId: 'pix', ordem: 2, status: 'em_andamento' })]
    })
    const extra = envio({ id: 'e2', projectCwd: cwd, planSlug: 'plano-a', entregas: [entrega({ etapaId: 'hotfix', status: 'concluida' })] })
    const outroPlano = envio({ id: 'e3', projectCwd: cwd, planSlug: 'outro', entregas: [entrega({ etapaId: 'x', status: 'concluida' })] })
    const source = vi.fn(async (): Promise<HandoffEnvio[]> => [parte1, extra, outroPlano])
    const out = await list(source)
    // base pronta + hotfix pronto, de 4 do roteiro + 1 fora dele; a "concluida" do roteiro não conta.
    expect(etapas(out)['plano-a']).toEqual({ total: 5, concluidas: 2, fonte: 'implementacao' })
    // Plano sem envios: a especificação (o vazio continua 0/0).
    expect(etapas(out)['plano-b']).toEqual({ total: 0, concluidas: 0, fonte: 'especificacao' })
    // Uma leitura dos envios por lista, pelo projeto.
    expect(source).toHaveBeenCalledTimes(1)
    expect(source).toHaveBeenCalledWith(cwd)
  })

  it('sem envios do plano, ou sem banco: a especificação do roteiro (especificadas de total)', async () => {
    const spec = { total: 4, concluidas: 3, fonte: 'especificacao' }
    expect(etapas(await list(async () => []))['plano-a']).toEqual(spec)
    expect(etapas(await list(async () => Promise.reject(new Error('banco offline'))))['plano-a']).toEqual(spec)
  })
})

describe('planEtapasProgress', () => {
  const roteiro = [
    { id: 'a', titulo: 'A', status: 'concluida' as const },
    { id: 'b', titulo: 'B', status: 'pendente' as const }
  ]

  it('com envios conta as prontas da implementação; sem, as especificadas — e diz qual das duas (fonte)', () => {
    const e = envio({ entregas: [entrega({ etapaId: 'b', status: 'concluida' })] })
    expect(planEtapasProgress(roteiro, [e])).toEqual({ total: 2, concluidas: 1, fonte: 'implementacao' })
    expect(planEtapasProgress(roteiro, [envio({ entregas: [entrega({ etapaId: 'a', status: 'em_andamento' })] })])).toEqual({
      total: 2,
      concluidas: 0,
      fonte: 'implementacao'
    })
    expect(planEtapasProgress(roteiro, [])).toEqual({ total: 2, concluidas: 1, fonte: 'especificacao' })
  })
})
