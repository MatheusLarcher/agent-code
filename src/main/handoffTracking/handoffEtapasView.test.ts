// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HANDOFF_ROUTINE_FILE, type HandoffEntrega, type HandoffEnvio } from '../../shared/handoffTracking'
import type { RemoteEtapasProgress } from '../../shared/ipc'
import { planProgress, type PlanProgress } from '../../shared/stepProgress'
import {
  conversationEnvio,
  etapasProgressView,
  HandoffEtapasCache,
  loadConversationEtapas,
  MOTIVO_MAX_CHARS,
  SEM_PLACAR_TTL_MS,
  type EtapasViewDeps
} from './handoffEtapasView'

/**
 * O placar das etapas do celular: a vista pura sobre planProgress (a regra
 * única), a leitura da conversa (o envio corrente, sem a rotina do PO) e o cache
 * síncrono do /api/state — tudo sem banco (as deps são funções).
 */

const AT = '2026-10-05T12:00:00.000Z'
const min = (m: number): string => new Date(Date.UTC(2026, 9, 5, 12, m)).toISOString()

function entrega(etapaId: string, status: HandoffEntrega['status'], ordem: number, motivo: string | null = null): HandoffEntrega {
  return {
    id: `hn-${etapaId}`, envioId: 'he-1', etapaId, etapaTitulo: `Etapa ${etapaId}`, ordem, estimativaPlano: null, estimativaAgente: null,
    estimativaAgenteMotivo: null, estimativaAgenteEm: null, status, atrasada: false, motivo, boardItemId: null, auditada: null,
    corrigidoPor: null, corrigidoEm: null, iniciadaEm: null, concluidaEm: null, tempoAtivoMs: 0, tempoCorridoMs: null, retrabalhoMs: 0,
    aviso80Em: null, aviso100Em: null, updatedAt: AT
  }
}

function envio(over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return {
    id: 'he-1', planSlug: 'checkout', planTitulo: 'Checkout', projectId: 'p', projectCwd: 'C:/proj', conversationId: 'impl',
    conversationTitle: 'Implementação', arquivo: '2026-10-05-01.md', ordem: 1, loteId: 'hl-1', conteudo: '', conteudoHash: '', status: 'em_execucao',
    motivo: null, estimativaTotal: null, prazoTotal: null, atrasado: false, tempoAtivoMs: 0, retrabalhoMs: 0, criadoEm: AT, enviadoEm: AT,
    iniciadoEm: AT, concluidoEm: null, updatedAt: AT, entregas: [], ...over
  }
}

const ROTEIRO = Array.from({ length: 10 }, (_, i) => ({ id: `e${i + 1}`, titulo: `Etapa ${i + 1}` }))
const MOTIVO_LONGO = 'faltou o teste de integração do checkout '.repeat(8)

/** O plano de 10 etapas num lote de 2 prompts: o 1º saiu com todas as etapas (9 prontas, a 7ª trincada),
 *  o 2º espera na fila e a rotina do PO (commit) saiu por último. */
function plano(): { corrente: HandoffEnvio; envios: HandoffEnvio[]; progress: PlanProgress } {
  const entregas = ROTEIRO.map((e, i) => entrega(e.id, e.id === 'e7' ? 'incompleta' : 'concluida', i + 1, e.id === 'e7' ? MOTIVO_LONGO : null))
  const corrente = envio({ entregas, status: 'incompleta' })
  const fila = envio({ id: 'he-2', ordem: 2, arquivo: '2026-10-05-02.md', status: 'na_fila', enviadoEm: null, iniciadoEm: null })
  const rotina = envio({ id: 'he-r', arquivo: HANDOFF_ROUTINE_FILE, ordem: 3, status: 'concluida', criadoEm: min(2), enviadoEm: min(2) })
  const envios = [corrente, fila, rotina]
  return { corrente, envios, progress: planProgress(envios, ROTEIRO) }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('etapasProgressView — a vista pura do placar', () => {
  it('10 etapas, 9 prontas e 1 trinca: as contas do plano, as etapas na ordem do roteiro com estado e motivo (cortado), a atual e "Prompt 1 de 2"', () => {
    const { corrente, envios, progress } = plano()
    const view = etapasProgressView(progress, corrente, envios)
    expect(view).toMatchObject({
      planSlug: 'checkout',
      planTitulo: 'Checkout',
      prompt: { n: 1, m: 2 },
      envioStatus: 'incompleta',
      total: 10,
      prontas: 9,
      incompletas: 1,
      atual: 7
    })
    expect(view.steps.map((s) => `${s.n}.${s.id}:${s.state}`)).toEqual(ROTEIRO.map((e, i) => `${i + 1}.${e.id}:${e.id === 'e7' ? 'trinca' : 'pronto'}`))
    expect(view.steps.map((s) => s.titulo)).toEqual(ROTEIRO.map((e) => e.titulo))
    // O motivo só na trinca, cortado para caber na linha do celular.
    expect(view.steps.filter((s) => s.motivo !== null).map((s) => s.id)).toEqual(['e7'])
    const motivo = view.steps[6].motivo ?? ''
    expect(MOTIVO_LONGO.length).toBeGreaterThan(MOTIVO_MAX_CHARS)
    expect(motivo.length).toBeLessThanOrEqual(MOTIVO_MAX_CHARS)
    expect(motivo.endsWith('…')).toBe(true)
    expect(MOTIVO_LONGO.startsWith(motivo.slice(0, -1))).toBe(true)
  })

  it('a atual é a de currentEntrega do envio DA CONVERSA (em andamento primeiro); planta para o que nunca saiu; tudo pronto → null; motivo curto inteiro', () => {
    const entregas = [entrega('e1', 'concluida', 1), entrega('e2', 'em_andamento', 2), entrega('e3', 'incompleta', 3, '  faltou o aceite  ')]
    const e = envio({ entregas })
    const view = etapasProgressView(planProgress([e], ROTEIRO), e, [e])
    expect(view).toMatchObject({ total: 10, prontas: 1, incompletas: 1, atual: 2, prompt: { n: 1, m: 1 } })
    expect(view.steps.map((s) => s.state)).toEqual(['pronto', 'massa', 'trinca', ...Array<'planta'>(7).fill('planta')])
    expect(view.steps[2].motivo).toBe('faltou o aceite')
    const pronto = envio({ entregas: [entrega('e1', 'concluida', 1)], status: 'concluida' })
    expect(etapasProgressView(planProgress([pronto], ROTEIRO.slice(0, 1)), pronto, [pronto])).toMatchObject({ total: 1, prontas: 1, incompletas: 0, atual: null })
  })
})

describe('loadConversationEtapas — o placar de uma conversa', () => {
  it('lista os envios da conversa, escolhe o corrente (sem a rotina do PO) e conta com o planProgress das deps; conversa sem envio → null', async () => {
    const { corrente, envios, progress } = plano()
    const listHandoffEnvios = vi.fn(async (query: { conversationId?: string }) => (query.conversationId === 'impl' ? envios : []))
    const load = vi.fn(async () => progress)
    const deps: EtapasViewDeps = { repository: () => ({ listHandoffEnvios }), planProgress: load }
    expect(await loadConversationEtapas('impl', deps)).toEqual(etapasProgressView(progress, corrente, envios))
    expect(listHandoffEnvios).toHaveBeenCalledWith({ conversationId: 'impl' })
    // A rotina saiu por último, mas não fala pelo prompt: o progresso é do envio corrente de verdade.
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith(corrente)
    expect(await loadConversationEtapas('outra', deps)).toBeNull()
  })

  it('nunca lança: sem banco (null ou erro ao abrir), erro na listagem ou no progresso → null', async () => {
    const { envios } = plano()
    expect(await loadConversationEtapas('impl', { repository: () => null })).toBeNull()
    expect(
      await loadConversationEtapas('impl', {
        repository: () => {
          throw new Error('Persistência autoritativa offline.')
        }
      })
    ).toBeNull()
    expect(await loadConversationEtapas('impl', { repository: () => ({ listHandoffEnvios: async () => Promise.reject(new Error('sql')) }) })).toBeNull()
    expect(
      await loadConversationEtapas('impl', {
        repository: () => ({ listHandoffEnvios: async () => envios }),
        planProgress: async () => Promise.reject(new Error('roteiro'))
      })
    ).toBeNull()
  })

  it('conversationEnvio: o corrente sem a rotina; nada enviado ainda → o mais novo registrado; só rotina, ou nada → null', () => {
    const { envios } = plano()
    expect(conversationEnvio(envios)?.id).toBe('he-1')
    const q1 = envio({ id: 'q1', status: 'na_fila', enviadoEm: null, criadoEm: min(1) })
    const q2 = envio({ id: 'q2', status: 'na_fila', enviadoEm: null, criadoEm: min(5) })
    expect(conversationEnvio([q1, q2])?.id).toBe('q2')
    expect(conversationEnvio([envios[2]])).toBeNull()
    expect(conversationEnvio([])).toBeNull()
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const PLACAR: RemoteEtapasProgress = {
  planSlug: 'checkout',
  planTitulo: 'Checkout',
  prompt: { n: 1, m: 1 },
  envioStatus: 'em_execucao',
  total: 2,
  prontas: 1,
  incompletas: 0,
  atual: 2,
  steps: [
    { id: 'a', titulo: 'Banco', n: 1, state: 'pronto', motivo: null },
    { id: 'b', titulo: 'Tela', n: 2, state: 'massa', motivo: null }
  ]
}
const SEM_BANCO: EtapasViewDeps = { repository: () => null }

describe('HandoffEtapasCache — o cache síncrono do /api/state', () => {
  it('get é síncrono: undefined até a carga terminar; gets concorrentes disparam UMA carga por conversa', async () => {
    const d = deferred<RemoteEtapasProgress | null>()
    const load = vi.fn((_convId: string) => d.promise)
    const cache = new HandoffEtapasCache(SEM_BANCO, { load })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
    expect(load.mock.calls.map((call) => call[0])).toEqual(['a', 'b'])
    d.resolve(PLACAR)
    await flush()
    expect(cache.get('a')).toBe(PLACAR)
    expect(cache.get('b')).toBe(PLACAR)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('invalidate apaga e recarrega na próxima get; a carga em voo invalidada é descartada', async () => {
    const pending: Deferred<RemoteEtapasProgress | null>[] = []
    const load = vi.fn(() => {
      const d = deferred<RemoteEtapasProgress | null>()
      pending.push(d)
      return d.promise
    })
    const cache = new HandoffEtapasCache(SEM_BANCO, { load })
    cache.get('a')
    pending[0].resolve(PLACAR)
    await flush()
    expect(cache.get('a')).toBe(PLACAR)
    cache.invalidate('a')
    expect(cache.get('a')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    // Invalidada de novo com a 2ª carga em voo: o que ela trouxer já é velho; vale a 3ª.
    cache.invalidate('a')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('a')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(3)
    const velho = { ...PLACAR, prontas: 0 }
    const novo = { ...PLACAR, prontas: 2 }
    pending[1].resolve(velho)
    await flush()
    expect(cache.get('a')).toBeUndefined()
    pending[2].resolve(novo)
    await flush()
    expect(cache.get('a')).toBe(novo)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('erro ou conversa sem placar → undefined, sem lançar; fica "sem placar" por 60 s (ou até o invalidate) antes de voltar ao banco', async () => {
    let now = 1_000_000
    const load = vi.fn(async (id: string) => {
      if (id === 'erro') throw new Error('sql')
      return null
    })
    const cache = new HandoffEtapasCache(SEM_BANCO, { load, now: () => now })
    expect(cache.get('erro')).toBeUndefined()
    expect(cache.get('vazia')).toBeUndefined()
    await flush()
    expect(cache.get('erro')).toBeUndefined()
    expect(cache.get('vazia')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    now += SEM_PLACAR_TTL_MS - 1
    expect(cache.get('vazia')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    now += 1
    expect(cache.get('vazia')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(3)
    cache.invalidate('erro')
    expect(cache.get('erro')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('sem `load`, carrega por loadConversationEtapas com as deps (repositório só-leitura + planProgress)', async () => {
    const { corrente, envios, progress } = plano()
    const cache = new HandoffEtapasCache({ repository: () => ({ listHandoffEnvios: async () => envios }), planProgress: async () => progress })
    expect(cache.get('impl')).toBeUndefined()
    await flush()
    expect(cache.get('impl')).toEqual(etapasProgressView(progress, corrente, envios))
    // Sem banco: undefined, e nada lançado.
    const offline = new HandoffEtapasCache(SEM_BANCO)
    expect(offline.get('impl')).toBeUndefined()
    await flush()
    expect(offline.get('impl')).toBeUndefined()
  })

  it('dispose: esquece tudo, ignora a carga em voo e não dispara mais nenhuma', async () => {
    const d = deferred<RemoteEtapasProgress | null>()
    const load = vi.fn(() => d.promise)
    const cache = new HandoffEtapasCache(SEM_BANCO, { load })
    cache.get('a')
    cache.dispose()
    d.resolve(PLACAR)
    await flush()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
