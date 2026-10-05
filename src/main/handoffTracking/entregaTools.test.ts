// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import {
  buildEntregaTools,
  ENTREGA_ESTIMAR_TOOL,
  ENTREGA_TEMPO_TOOL,
  entregaMcpServerFor,
  entregaServerApplies,
  entregaToolAutoAllowed,
  type EntregaTracker
} from './entregaTools'
import { activeHandoffTracker } from './handoffRuntime'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

/**
 * Contra o tracker e o SqliteRepository REAIS (handoffTrackerHarness): a regra
 * "a etapa é do envio corrente" e "o prazo não muda" só vale alguma coisa se o
 * banco de verdade mostrar isso depois da chamada.
 */

afterEach(closeHarnesses)

type Tool = ReturnType<typeof buildEntregaTools>[number]
type Result = { content: { type: string; text?: string }[] }

const MIN = 60_000
const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }

function call(tools: Tool[], name: string, args: unknown): Promise<string> {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`ferramenta ${name} não registrada`)
  return (found.handler(args as never, undefined) as Promise<Result>).then((r) => r.content.map((p) => p.text ?? '').join('\n'))
}

/** Dois prompts registrados; o 1º (etapas a e b) saiu e é o envio corrente; o 2º (c) espera na fila. */
async function sent(): Promise<{ h: Harness; tools: Tool[] }> {
  const h = await harness()
  await h.register([
    { conteudo: 'Prompt 1', etapas: ['etapa-a', 'etapa-b'] },
    { conteudo: 'Prompt 2', etapas: ['etapa-c'] }
  ])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  await h.settle()
  return { h, tools: buildEntregaTools({ conversationId: CONV, tracker: () => h.tracker }) }
}

const estimar = (tools: Tool[], args: Record<string, unknown>): Promise<string> => call(tools, 'entrega_estimar', args)
const tempo = (tools: Tool[], args: Record<string, unknown> = {}): Promise<string> => call(tools, 'entrega_tempo', args)

describe('entrega_estimar', () => {
  it('grava a estimativa do agente na entrega do envio corrente, sem tocar no prazo, e responde em pt-BR', async () => {
    const { h, tools } = await sent()
    const before = await h.envios()
    const changes = h.changed.length

    const out = await estimar(tools, { etapa: 'etapa-a', minutos: 20, motivo: 'só um handler novo e o teste' })

    expect(out).toContain('Estimativa registrada para [etapa-a] Etapa etapa-a (etapa 1 de 2 deste prompt).')
    expect(out).toContain('Prazo (estimativa do plano): 30 min — é ele que vale, e a sua estimativa não o muda.')
    expect(out).toContain('Sua estimativa: 20 min (motivo: só um handler novo e o teste).')
    expect(out).toContain('Escreva agora no chat: Etapa 1 — Etapa etapa-a: estimativa do plano 30 min (prazo), minha estimativa 20 min')
    expect(out).not.toMatch(/Substituiu/)

    const [envio, fila] = await h.envios()
    expect(envio.entregas[0]).toMatchObject({
      etapaId: 'etapa-a',
      estimativaPlano: 30,
      estimativaAgente: 20,
      estimativaAgenteMotivo: 'só um handler novo e o teste',
      estimativaAgenteEm: new Date(h.now()).toISOString()
    })
    // O prazo e o resto do envio ficam como estavam.
    expect(envio.prazoTotal).toBe(before[0].prazoTotal)
    expect(envio.estimativaTotal).toBe(before[0].estimativaTotal)
    expect(envio.entregas[1]).toEqual(before[0].entregas[1])
    expect(fila).toEqual(before[1])
    // A tela é avisada (handoff:changed) como nas outras escritas do tracker.
    expect(h.changed.slice(changes)).toContain(CONV)
  })

  it('chamar de novo sobrescreve, guardando o motivo novo (e diz qual substituiu); a estimativa do plano fica intacta', async () => {
    const { h, tools } = await sent()
    await estimar(tools, { etapa: 'etapa-b', minutos: 15, motivo: 'parecia simples' })
    h.advance(5 * MIN)
    const out = await estimar(tools, { etapa: 'etapa-b', minutos: 45, motivo: 'o repositório tem dois backends' })
    expect(out).toContain('Sua estimativa: 45 min (motivo: o repositório tem dois backends).')
    expect(out).toContain('Substituiu a anterior: 15 min (motivo: parecia simples).')
    const entrega = (await h.envios())[0].entregas[1]
    expect(entrega).toMatchObject({
      estimativaPlano: 30,
      estimativaAgente: 45,
      estimativaAgenteMotivo: 'o repositório tem dois backends',
      estimativaAgenteEm: new Date(h.now()).toISOString()
    })
  })

  it('etapa de OUTRO envio (ou inexistente) é recusada, sem gravar nada, listando as etapas do envio corrente', async () => {
    const { h, tools } = await sent()
    const before = await h.envios()
    for (const etapa of ['etapa-c', 'etapa-x']) {
      const out = await estimar(tools, { etapa, minutos: 10, motivo: 'qualquer' })
      expect(out).toContain(`Nada registrado. A etapa "${etapa}" não pertence ao envio corrente desta conversa (2026-10-05-01.md).`)
      expect(out).toContain('Etapas deste envio: [etapa-a] Etapa etapa-a (pendente); [etapa-b] Etapa etapa-b (pendente).')
    }
    expect(await h.envios()).toEqual(before)
  })

  it('minutos tem de ser inteiro de 1 a 10000 e o motivo, não vazio e até 500 caracteres: senão nada é gravado', async () => {
    const { h, tools } = await sent()
    const before = await h.envios()
    for (const minutos of [0, -5, 2.5, 10_001, Number.NaN]) {
      const out = await estimar(tools, { etapa: 'etapa-a', minutos, motivo: 'ok' })
      expect(out, String(minutos)).toMatch(/^Nada registrado\. "minutos" precisa ser um número inteiro de 1 a 10000/)
    }
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 10, motivo: '   ' })).toMatch(/^Nada registrado\. Diga o "motivo"/)
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 10, motivo: 'x'.repeat(501) })).toMatch(/o teto é 500/)
    expect(await h.envios()).toEqual(before)
    // Os limites valem.
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 1, motivo: 'm' })).toMatch(/^Estimativa registrada/)
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 10_000, motivo: 'm' })).toMatch(/^Estimativa registrada/)
  })

  it('aceita o id com colchetes e maiúsculas, como no item do TodoWrite', async () => {
    const { h, tools } = await sent()
    expect(await estimar(tools, { etapa: '[ETAPA-B] Etapa B', minutos: 12, motivo: 'm' })).toMatch(/^Estimativa registrada para \[etapa-b\]/)
    expect((await h.envios())[0].entregas[1].estimativaAgente).toBe(12)
  })

  it('sem envio corrente, sem banco, sem acompanhamento ou com o banco recusando: frase clara, sem lançar', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: ['etapa-a'] }]) // registrado, mas não saiu
    const tools = buildEntregaTools({ conversationId: CONV, tracker: () => h.tracker })
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 5, motivo: 'm' })).toMatch(
      /^Nada registrado\. Esta conversa não tem um envio de handoff registrado no banco/
    )
    expect(await tempo(tools)).toMatch(/^Esta conversa não tem um envio de handoff registrado/)

    const semBanco = buildEntregaTools({ conversationId: CONV, tracker: () => h.reopen({ repository: () => null }) })
    expect(await estimar(semBanco, { etapa: 'etapa-a', minutos: 5, motivo: 'm' })).toMatch(/O banco do app está indisponível agora/)

    const desligado = buildEntregaTools({ conversationId: CONV, tracker: () => null })
    expect(await estimar(desligado, { etapa: 'etapa-a', minutos: 5, motivo: 'm' })).toMatch(/^O acompanhamento das entregas não está ativo/)
    expect(await tempo(desligado)).toMatch(/^O acompanhamento das entregas não está ativo/)

    const quebrado: EntregaTracker = {
      estimateEntrega: async () => {
        throw new Error('SQLITE_BUSY')
      },
      entregaTime: async () => {
        throw new Error('SQLITE_BUSY')
      }
    }
    const falha = buildEntregaTools({ conversationId: CONV, tracker: () => quebrado })
    const out = await estimar(falha, { etapa: 'etapa-a', minutos: 5, motivo: 'm' })
    expect(out).toBe('entrega_estimar falhou: SQLITE_BUSY. Siga com a etapa; o tempo continua sendo medido pelo app.')
    expect(await tempo(falha)).toMatch(/^entrega_tempo falhou: SQLITE_BUSY\./)
  })

  it('envio sem etapas declaradas: não há prazo por etapa', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    const tools = buildEntregaTools({ conversationId: CONV, tracker: () => h.tracker })
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 5, motivo: 'm' })).toMatch(/não declarou etapas/)
  })
})

describe('entrega_tempo', () => {
  it('tempo ativo pela medição do app (gravado + fatia em curso), com dentro/fora do prazo e a linha pronta', async () => {
    const { h, tools } = await sent()
    await estimar(tools, { etapa: 'etapa-a', minutos: 20, motivo: 'm' })
    h.emit(turnStart)
    h.tasks([['[etapa-a] Fazer A', 'in_progress']])
    await h.settle()
    h.advance(10 * MIN)

    // Sem etapa: a em andamento.
    const agora = await tempo(tools)
    expect(agora).toContain('[etapa-a] Etapa etapa-a — etapa 1 de 2 deste prompt, em andamento.')
    expect(agora).toContain('Prazo (estimativa do plano): 30 min.')
    expect(agora).toContain('Sua estimativa: 20 min.')
    expect(agora).toContain('Tempo ativo medido pelo app: 10 min (33% do prazo) — dentro do prazo.')
    expect(agora).toMatch(/A contagem segue/)
    expect(agora).toContain('Ao concluir a etapa, escreva: levou 10 min de trabalho (dentro do prazo)')

    // A varredura grava a fatia; o total continua o mesmo (sem contar duas vezes).
    await h.tracker.sweep()
    h.advance(25 * MIN)
    const fora = await tempo(tools, { etapa: 'etapa-a' })
    expect(fora).toContain('Tempo ativo medido pelo app: 35 min (117% do prazo) — fora do prazo, passou 5 min.')
    expect(fora).toContain('levou 35 min de trabalho (fora do prazo) — e diga por que passou do prazo.')

    // Etapa ainda não começada: sem estimativa do agente, nada medido, e a fatia em curso não é dela.
    const b = await tempo(tools, { etapa: 'etapa-b' })
    expect(b).toContain('Sua estimativa: não registrada (registre com entrega_estimar ao começar a etapa).')
    expect(b).toContain('Tempo ativo medido pelo app: 0 min (0% do prazo) — dentro do prazo.')
    expect(b).not.toMatch(/A contagem segue/)
  })

  it('etapa concluída: vale o tempo gravado até a conclusão; a de outro envio é recusada', async () => {
    const { h, tools } = await sent()
    h.emit(turnStart)
    h.tasks([['[etapa-a] Fazer A', 'in_progress']])
    await h.settle()
    h.advance(12 * MIN)
    h.tasks([['[etapa-a] Fazer A', 'completed']])
    await h.settle()
    h.advance(7 * MIN)
    const out = await tempo(tools, { etapa: 'etapa-a' })
    expect(out).toContain('concluída.')
    expect(out).toContain('Tempo ativo medido pelo app: 12 min (40% do prazo) — dentro do prazo.')
    expect(out).not.toMatch(/A contagem segue/)
    expect(await tempo(tools, { etapa: 'etapa-c' })).toMatch(/A etapa "etapa-c" não pertence ao envio corrente/)
    // Sem etapa, a atual passa a ser a primeira não concluída.
    expect(await tempo(tools)).toContain('[etapa-b] Etapa etapa-b — etapa 2 de 2 deste prompt, pendente.')
  })
})

describe('onde o servidor `entregas` existe', () => {
  const slug = 'checkout'

  it('só na conversa de handoff: nunca no Agent Manager nem na conversa comum', () => {
    expect(entregaServerApplies({ handoff: { slug } })).toBe(true)
    expect(entregaServerApplies({})).toBe(false)
    expect(entregaServerApplies({ planning: { slug } })).toBe(false)
    // Manager e handoff juntos o IPC já recusa; se chegar, o Manager vence.
    expect(entregaServerApplies({ planning: { slug }, handoff: { slug } })).toBe(false)

    expect(entregaMcpServerFor({ convId: 'c1', handoff: { slug } })).toMatchObject({ type: 'sdk', name: 'entregas' })
    expect(entregaMcpServerFor({ convId: 'c1' })).toBeNull()
    expect(entregaMcpServerFor({ convId: 'c1', planning: { slug } })).toBeNull()
    expect(entregaMcpServerFor({ convId: 'c1', planning: { slug }, handoff: { slug } })).toBeNull()
  })

  it('o servidor tem as duas ferramentas, com os nomes completos que o bloco do handoff cita', () => {
    const server = entregaMcpServerFor({ convId: 'c1', handoff: { slug } }) as unknown as {
      instance: { _registeredTools?: Record<string, unknown> }
    }
    expect(Object.keys(server.instance._registeredTools ?? {}).sort()).toEqual(['entrega_estimar', 'entrega_tempo'])
    expect([ENTREGA_ESTIMAR_TOOL, ENTREGA_TEMPO_TOOL]).toEqual(['mcp__entregas__entrega_estimar', 'mcp__entregas__entrega_tempo'])
  })

  it('passam sem pedir permissão só na conversa de handoff, e só as duas', () => {
    expect(entregaToolAutoAllowed({ handoff: { slug } }, ENTREGA_ESTIMAR_TOOL)).toBe(true)
    expect(entregaToolAutoAllowed({ handoff: { slug } }, ENTREGA_TEMPO_TOOL)).toBe(true)
    expect(entregaToolAutoAllowed({ handoff: { slug } }, 'mcp__entregas__outra')).toBe(false)
    // Um servidor do usuário chamado `entregas` numa conversa comum não ganha o atalho.
    expect(entregaToolAutoAllowed({}, ENTREGA_ESTIMAR_TOOL)).toBe(false)
    expect(entregaToolAutoAllowed({ planning: { slug } }, ENTREGA_TEMPO_TOOL)).toBe(false)
  })

  it('sem tracker injetado, as ferramentas usam o do processo (handoffRuntime): o último criado', async () => {
    const h = await harness()
    expect(activeHandoffTracker()).toBe(h.tracker)
    await h.register([{ conteudo: 'Prompt 1', etapas: ['etapa-a'] }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    const tools = buildEntregaTools({ conversationId: CONV })
    expect(await estimar(tools, { etapa: 'etapa-a', minutos: 8, motivo: 'm' })).toMatch(/^Estimativa registrada/)
    expect((await h.envios())[0].entregas[0].estimativaAgente).toBe(8)
  })
})
