import { describe, expect, it, vi } from 'vitest'
import { isStallMotivo, type HandoffEntrega, type HandoffEnvio } from '../../shared/handoffTracking'
import type { ScrumMasterConfig } from '../../shared/ipc'
import { handoffContentHash } from '../handoffTracking/handoffModel'
import { entrega, envio, T0 } from '../handoffTracking/handoffTestKit'
import { ScrumMaster } from './scrumMaster'
import { scrumFixedCharge } from './scrumPromptText'
import type { ScrumDecisao } from './scrumTypes'

// O serviço do SM com tracker, sessões, modelo e relógio falsos. Prazo da etapa:
// 20 min (150% = 30, 200% = 40, 300% = 60); a espera do travado: 10 min.

const MIN = 60_000
const CONV = 'conv-1'
const PEDIDO = 'Prompt 1'

/** O envio com a etapa `acoes` em andamento a `ms` de tempo ativo. */
function at(ms: number, over: Partial<HandoffEntrega> = {}, envioOver: Partial<HandoffEnvio> = {}): HandoffEnvio {
  const e = entrega({ etapaId: 'acoes', status: 'em_andamento', estimativaPlano: 20, tempoAtivoMs: ms, ...over })
  return envio({ conteudoHash: handoffContentHash(PEDIDO), entregas: [e], ...envioOver })
}

const desvio = 'DESVIO | reexplorando | relê os mesmos arquivos\nCOBRANCA | Pare de reler e feche a etapa.'
const parar = 'PARAR | laço sem saída no typecheck\nCOBRANCA | Pare.'
const justificado = 'JUSTIFICADO | a etapa foi subestimada\nCOBRANCA | Feche a etapa logo.'

function harness(o: { config?: Partial<ScrumMasterConfig>; history?: ScrumDecisao[]; logThrows?: boolean } = {}) {
  const s = {
    t: T0,
    envio: at(0) as HandoffEnvio | null,
    running: true,
    answer: desvio as string | Error,
    interruptOk: true,
    order: [] as string[],
    logs: [] as ScrumDecisao[],
    notices: [] as string[],
    sent: [] as string[],
    prompts: [] as string[]
  }
  const tracker = {
    currentEnvio: vi.fn(async () => s.envio),
    isTurnRunning: vi.fn(() => s.running),
    noteStop: vi.fn((_c: string, motivo?: string | null) => void s.order.push(`noteStop:${motivo}`)),
    noteScrumCut: vi.fn((_c: string, on: boolean) => void s.order.push(`cut:${on}`))
  }
  const interrupt = vi.fn(async () => {
    s.order.push('interrupt')
    return s.interruptOk
  })
  const config = { enabled: true, model: 'claude-haiku-5-5', podeParar: true, ...o.config }
  const sm = new ScrumMaster({
    tracker,
    liveConversations: () => [CONV],
    interrupt,
    send: async (_c, text) => void s.sent.push(text),
    config: () => config,
    conversation: async () => ({
      messages: [
        { kind: 'user', text: 'pedido antigo' },
        { kind: 'assistant-text', text: 'resposta de outro envio' },
        { kind: 'user', text: PEDIDO },
        { kind: 'assistant-text', text: 'Comecei a etapa 3.' },
        { kind: 'tool', text: 'saída de ferramenta' },
        { kind: 'assistant-text', text: 'texto do subagente', parentToolUseId: 'tu-1' },
        { kind: 'assistant-text', text: 'Rodando os testes de novo.' }
      ]
    }),
    ask: async (prompt) => {
      s.prompts.push(prompt)
      if (s.answer instanceof Error) throw s.answer
      return s.answer
    },
    log: (d) => {
      if (o.logThrows) throw new Error('disco cheio')
      s.logs.push(d)
    },
    publish: (_c, texto) => void s.notices.push(texto),
    history: async () => o.history ?? [],
    now: () => s.t,
    uuid: () => `id-${s.logs.length}`,
    warn: () => undefined
  })
  const tipos = () => s.logs.map((d) => d.tipo)
  return { s, sm, tracker, interrupt, config, tipos }
}

describe('ScrumMaster — marcos: julga só pelas respostas do agente e entrega pelo hook', () => {
  it('150%: consulta o modelo uma vez com o texto do agente principal e deixa a cobrança para o hook, uma vez', async () => {
    const h = harness()
    h.s.envio = at(30 * MIN)
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(1)
    const prompt = h.s.prompts[0]
    expect(prompt).toContain('Comecei a etapa 3.')
    expect(prompt).toContain('Rodando os testes de novo.')
    expect(prompt).not.toContain('resposta de outro envio')
    expect(prompt).not.toContain('saída de ferramenta')
    expect(prompt).not.toContain('texto do subagente')
    expect(prompt).toContain('Etapa 1 (acoes)')
    expect(h.sm.takeCharge(CONV)).toBe('📋 Scrum Master — etapa 1, 1,5× do prazo: Pare de reler e feche a etapa.')
    expect(h.sm.takeCharge(CONV)).toBeNull()
    expect(h.tipos()).toEqual(['cobrou', 'entregue'])
    expect(h.s.notices).toEqual([])
    // O mesmo marco não dispara de novo.
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(1)
  })

  it('200%: o resumo ao usuário; abaixo de 150%, nada', async () => {
    const h = harness()
    h.s.envio = at(29 * MIN)
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(0)
    h.s.envio = at(40 * MIN)
    await h.sm.onSweep()
    expect(h.s.notices).toEqual([expect.stringContaining('Etapa 1 (acoes): 2× do prazo — desvio (reexplorando).')])
  })

  it('o modelo falhando: cobrança de texto fixo, `falha` no diário, nunca corta nem para (nem no 300%)', async () => {
    const h = harness()
    h.s.answer = new Error('rota fora')
    h.s.envio = at(60 * MIN)
    await h.sm.onSweep()
    expect(h.sm.takeCharge(CONV)).toBe(`📋 Scrum Master — etapa 1, 3× do prazo: ${scrumFixedCharge(1, 'acoes', '3×')}`)
    expect(h.tipos()).toEqual(['falha', 'entregue'])
    expect(h.interrupt).not.toHaveBeenCalled()
    expect(h.tracker.noteStop).not.toHaveBeenCalled()
  })

  it('desligado: nada consulta, e a cobrança pendente não sai', async () => {
    const h = harness({ config: { enabled: false } })
    h.s.envio = at(60 * MIN)
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(0)
    expect(h.sm.takeCharge(CONV)).toBeNull()
  })

  it('o diário quebrando não derruba a passada: a cobrança segue pendente', async () => {
    const h = harness({ logThrows: true })
    h.s.envio = at(30 * MIN)
    await expect(h.sm.onSweep()).resolves.toBeUndefined()
    expect(h.sm.takeCharge(CONV)).toContain('📋 Scrum Master')
  })
})

describe('ScrumMaster — a parada do 300%', () => {
  it('PARAR + podeParar: o Stop com o motivo do SM ANTES do interrupt, a nota única, `parou` e o resumo', async () => {
    const h = harness()
    h.s.answer = parar
    h.s.envio = at(60 * MIN)
    await h.sm.onSweep()
    expect(h.s.order).toEqual(['noteStop:Scrum Master: laço sem saída no typecheck', 'interrupt'])
    expect(isStallMotivo('Scrum Master: laço sem saída no typecheck')).toBe(false)
    expect(h.tracker.noteScrumCut).not.toHaveBeenCalled()
    expect(h.tipos()).toEqual(['parou'])
    expect(h.s.notices).toEqual([expect.stringContaining('O Scrum Master parou o envio: laço sem saída no typecheck. A fila espera você.')])
    const note = h.sm.takeStopNote(CONV)
    expect(note).toMatch(/^\[Scrum Master\] Este envio foi parado às \d\d:\d\d por: laço sem saída no typecheck\. Antes de seguir, confira/)
    expect(h.sm.takeStopNote(CONV)).toBeNull()
    expect(h.sm.takeCharge(CONV)).toBeNull()
  })

  it('uma parada por envio: a etapa seguinte no 300% com PARAR só cobra', async () => {
    const h = harness()
    h.s.answer = parar
    h.s.envio = at(60 * MIN)
    await h.sm.onSweep()
    h.s.envio = at(60 * MIN, { id: 'hn-b', etapaId: 'b' })
    await h.sm.onSweep()
    expect(h.tracker.noteStop).toHaveBeenCalledTimes(1)
    expect(h.tipos()).toEqual(['parou', 'cobrou'])
  })

  it('a parada já registrada no diário (app reaberto) também conta', async () => {
    const h = harness({ history: [{ tipo: 'parou', envioId: 'he-1', entregaId: 'hn-x', marco: 300 } as ScrumDecisao] })
    h.s.answer = parar
    h.s.envio = at(60 * MIN)
    await h.sm.onSweep()
    expect(h.tracker.noteStop).not.toHaveBeenCalled()
  })

  it('sem podeParar, abaixo do 300% ou com declaração válida: não para', async () => {
    const sem = harness({ config: { podeParar: false } })
    sem.s.answer = parar
    sem.s.envio = at(60 * MIN)
    await sem.sm.onSweep()
    expect(sem.tracker.noteStop).not.toHaveBeenCalled()

    const dois = harness()
    dois.s.answer = parar
    dois.s.envio = at(40 * MIN)
    await dois.sm.onSweep()
    expect(dois.tracker.noteStop).not.toHaveBeenCalled()
    expect(dois.s.logs[0]).toMatchObject({ tipo: 'cobrou', veredito: 'desvio' })

    const decl = harness()
    decl.s.answer = parar
    decl.s.envio = at(50 * MIN)
    await decl.sm.declare(CONV, { minutos: 30, motivo: 'build completo' })
    decl.s.envio = at(60 * MIN)
    await decl.sm.onSweep()
    expect(decl.tracker.noteStop).not.toHaveBeenCalled()
  })
})

describe('ScrumMaster — o travado', () => {
  /** A cobrança dos 150% pendente e o relógio `minutos` depois, com o turno rodando. */
  async function pendente(h: ReturnType<typeof harness>, minutos: number): Promise<void> {
    h.s.envio = at(30 * MIN)
    await h.sm.onSweep()
    h.s.t += minutos * MIN
  }

  it('sem declaração, o modelo decide: JUSTIFICADO espera; DESVIO corta sem as marcas do Stop e manda a mensagem', async () => {
    const espera = harness()
    await pendente(espera, 10)
    espera.s.answer = justificado
    await espera.sm.onSweep()
    expect(espera.interrupt).not.toHaveBeenCalled()
    expect(espera.tipos()).toEqual(['cobrou', 'deixou-seguir'])

    const h = harness()
    await pendente(h, 10)
    await h.sm.onSweep()
    expect(h.s.order).toEqual(['cut:true', 'interrupt'])
    expect(h.tracker.noteStop).not.toHaveBeenCalled()
    expect(h.s.sent).toHaveLength(1)
    expect(h.s.sent[0]).toContain('eu interrompi o seu turno porque relê os mesmos arquivos')
    expect(h.s.sent[0]).toContain('O pedido NÃO foi cancelado')
    expect(h.s.sent[0]).toContain('Agora: continue a etapa, diga em uma linha o que falta, ou registre o bloqueio.')
    expect(h.tipos()).toEqual(['cobrou', 'interrompeu'])
    expect(h.s.notices.at(-1)).toContain('interrompeu o turno')
    expect(h.sm.takeCharge(CONV)).toBeNull()
  })

  it('antes dos 10 min, ou sem turno rodando, não há travado', async () => {
    const h = harness()
    await pendente(h, 9)
    await h.sm.onSweep()
    h.s.running = false
    h.s.t += 5 * MIN
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(1)
    expect(h.interrupt).not.toHaveBeenCalled()
  })

  it('dentro da declaração: deixa seguir sem consultar; passada ela: corta', async () => {
    const h = harness()
    await h.sm.declare(CONV, { minutos: 25, motivo: 'varredura do repositório' })
    await pendente(h, 10)
    await h.sm.onSweep()
    expect(h.s.prompts).toHaveLength(1)
    expect(h.interrupt).not.toHaveBeenCalled()
    expect(h.tipos()).toEqual(['declarou', 'cobrou', 'deixou-seguir'])
    h.s.t += 20 * MIN
    await h.sm.onSweep()
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    expect(h.s.prompts).toHaveLength(1)
    expect(h.s.sent[0]).toContain('passou do tempo que você declarou')
  })

  it('o stallWatch já encerrou o turno: não corta e a cobrança continua pendente', async () => {
    const h = harness()
    h.s.interruptOk = false
    await pendente(h, 10)
    await h.sm.onSweep()
    expect(h.s.order).toEqual(['cut:true', 'interrupt', 'cut:false'])
    expect(h.s.sent).toEqual([])
    expect(h.sm.takeCharge(CONV)).toContain('📋 Scrum Master — etapa 1, 1,5× do prazo:')
  })

  it('o modelo falhando no travado: `falha`, sem corte', async () => {
    const h = harness()
    await pendente(h, 10)
    h.s.answer = ''
    await h.sm.onSweep()
    expect(h.interrupt).not.toHaveBeenCalled()
    expect(h.tipos()).toEqual(['cobrou', 'falha'])
  })

  it('uma intervenção forte por envio: o segundo travado só avisa o usuário', async () => {
    const h = harness()
    await pendente(h, 10)
    await h.sm.onSweep()
    h.s.envio = at(40 * MIN)
    await h.sm.onSweep()
    h.s.t += 10 * MIN
    await h.sm.onSweep()
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    expect(h.tipos()).toEqual(['cobrou', 'interrompeu', 'cobrou', 'avisou'])
  })
})

describe('ScrumMaster — entrega_aviso_demora', () => {
  it('até 3× o prazo vale inteiro; acima, vale o teto e o usuário é avisado', async () => {
    const h = harness()
    const ok = await h.sm.declare(CONV, { minutos: 45, motivo: 'build completo' })
    expect(ok).toContain('VALEU 45 min de relógio')
    expect(h.s.notices).toEqual([])
    const acima = await h.sm.declare(CONV, { minutos: 100, motivo: 'varredura' })
    expect(acima).toContain('VALEU 60 min de relógio')
    expect(acima).toContain('Você pediu 100 min')
    expect(h.s.notices).toEqual([expect.stringContaining('valeu 60 min. O resto precisa da sua aprovação.')])
    expect(h.s.logs.map((d) => [d.tipo, d.declaradoMin])).toEqual([
      ['declarou', 45],
      ['declarou', 60]
    ])
  })

  it('entrada inválida, sem etapa com prazo, e o SM desligado', async () => {
    const h = harness()
    expect(await h.sm.declare(CONV, { minutos: 0, motivo: 'x' })).toMatch(/^Nada registrado\./)
    expect(await h.sm.declare(CONV, { minutos: 10, motivo: ' ' })).toMatch(/^Nada registrado\./)
    h.s.envio = at(0, { estimativaPlano: 0 })
    expect(await h.sm.declare(CONV, { minutos: 10, motivo: 'build' })).toMatch(/^Nada registrado: esta conversa não tem uma etapa/)
    const off = harness({ config: { enabled: false } })
    const answer = await off.sm.declare(CONV, { minutos: 100, motivo: 'build' })
    expect(answer).toContain('VALEU 60 min')
    expect(answer).toContain('O Scrum Master está desligado')
    expect(off.s.notices).toEqual([])
    expect(off.tipos()).toEqual(['declarou'])
  })
})
