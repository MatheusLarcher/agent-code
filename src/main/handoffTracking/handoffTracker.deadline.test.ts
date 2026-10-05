// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import type { HandoffEntregaPatch, HandoffEnvioPatch } from '../persistence/types'
import { iso } from './handoffTestKit'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

// O prazo por etapa de ponta a ponta: tracker real + SQLite real, relógio
// injetado. Atraso só na virada (falso → verdadeiro, status intacto) e o aviso
// ao agente nos marcos de 80% e 100%, uma vez por marco.

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }
const SEC = 1_000
const MIN = 60_000

async function running(etapas: string[], estimativas?: Array<number | null>, h?: Harness): Promise<Harness> {
  h ??= await harness()
  await h.register([{ conteudo: 'Prompt 1', etapas, estimativas }])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  await h.settle()
  return h
}

async function inProgress(h: Harness, items: Array<[string, 'pending' | 'in_progress' | 'completed']>): Promise<void> {
  h.tasks(items)
  await h.settle()
}

/** As gravações de atraso, em ordem ("envio:true", "entrega:true"). */
function recordLateWrites(h: Harness): string[] {
  const writes: string[] = []
  const entrega = h.repo.updateHandoffEntrega.bind(h.repo)
  const envio = h.repo.updateHandoffEnvio.bind(h.repo)
  h.repo.updateHandoffEntrega = async (id: string, patch: HandoffEntregaPatch) => {
    if (patch.atrasada !== undefined) writes.push(`entrega:${patch.atrasada}`)
    return entrega(id, patch)
  }
  h.repo.updateHandoffEnvio = async (id: string, patch: HandoffEnvioPatch) => {
    if (patch.atrasado !== undefined) writes.push(`envio:${patch.atrasado}`)
    return envio(id, patch)
  }
  return writes
}

const notice = (h: Harness): Promise<string | null> => h.tracker.deadlineNotice(CONV)

describe('HandoffTracker — atraso pelo tempo ativo', () => {
  it('a entrega e o envio viram atrasados ao PASSAR do prazo, uma gravação cada, sem mudar o status', async () => {
    const h = await running(['a'])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    const writes = recordLateWrites(h)

    h.advance(30 * MIN)
    await h.tracker.sweep()
    let [envio] = await h.envios()
    // Exatamente no prazo ainda é dentro.
    expect(envio).toMatchObject({ tempoAtivoMs: 30 * MIN, atrasado: false })
    expect(envio.entregas[0]).toMatchObject({ tempoAtivoMs: 30 * MIN, atrasada: false })

    const changedBefore = h.changed.length
    h.advance(SEC)
    await h.tracker.sweep()
    ;[envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'em_execucao', atrasado: true })
    expect(envio.entregas[0]).toMatchObject({ status: 'em_andamento', atrasada: true })
    expect(h.changed.slice(changedBefore)).toContain(CONV)

    // Mais tempo, mais flushes, o fim do turno: nenhuma gravação nova da marca.
    h.advance(10 * MIN)
    await h.tracker.sweep()
    await inProgress(h, [['[a] Fazer A', 'completed']])
    h.emit(result)
    await h.settle()
    ;[envio] = await h.envios()
    expect(writes).toEqual(['envio:true', 'entrega:true'])
    // O status de execução segue o próprio caminho; a marca fica à parte.
    expect(envio).toMatchObject({ status: 'concluida', atrasado: true })
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', atrasada: true })
  })

  it('cada um no seu prazo: a etapa estoura sozinha; o envio, pela soma', async () => {
    const h = await running(['a', 'b'])
    await inProgress(h, [['[a] Fazer A', 'in_progress'], ['[b] Fazer B', 'pending']])
    h.advance(31 * MIN)
    await h.tracker.sweep()
    let [envio] = await h.envios()
    expect(envio.prazoTotal).toBe(60)
    expect(envio.atrasado).toBe(false)
    expect(envio.entregas.map((e) => e.atrasada)).toEqual([true, false])

    await inProgress(h, [['[a] Fazer A', 'completed'], ['[b] Fazer B', 'in_progress']])
    h.advance(29 * MIN)
    await h.tracker.sweep()
    expect((await h.envios())[0].atrasado).toBe(false)
    h.advance(SEC)
    await h.tracker.sweep()
    ;[envio] = await h.envios()
    expect(envio).toMatchObject({ tempoAtivoMs: 60 * MIN + SEC, atrasado: true })
    expect(envio.entregas.map((e) => e.atrasada)).toEqual([true, false])
  })

  it('retrabalho não conta: o envio concluído no prazo não atrasa por mensagem nova', async () => {
    const h = await running(['a'])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(10 * MIN)
    await inProgress(h, [['[a] Fazer A', 'completed']])
    h.emit(result)
    await h.settle()
    h.tracker.noteUserSend(CONV, 'ajuste o botão')
    h.emit({ kind: 'turn-start', turnIds: ['u2'] })
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(90 * MIN)
    await h.tracker.sweep()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', tempoAtivoMs: 10 * MIN, retrabalhoMs: 90 * MIN, atrasado: false })
    expect(envio.entregas[0]).toMatchObject({ atrasada: false, retrabalhoMs: 90 * MIN })
    expect(await notice(h)).toBeNull()
  })

  it('etapa sem estimativa do plano: nunca atrasa nem avisa', async () => {
    const h = await running(['a'], [null])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(500 * MIN)
    expect(await notice(h)).toBeNull()
    await h.tracker.sweep()
    expect(await notice(h)).toBeNull()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ prazoTotal: null, atrasado: false, tempoAtivoMs: 500 * MIN })
    expect(envio.entregas[0]).toMatchObject({ atrasada: false, aviso80Em: null, aviso100Em: null })
  })
})

describe('HandoffTracker.deadlineNotice — o aviso ao agente', () => {
  it('80% e depois 100% da etapa em andamento, uma vez cada, contando a fatia ainda não gravada', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    expect(await notice(h)).toBeNull()

    h.advance(32 * MIN - SEC)
    expect(await notice(h)).toBeNull()
    h.advance(SEC)
    const at80 = h.now()
    expect(await notice(h)).toMatch(/^⏱ Etapa 1 \(a\): 32 de 40 min de trabalho — 80% do prazo da etapa/)
    let [envio] = await h.envios()
    // Nada foi gravado de tempo ainda: o marco veio da fatia em memória.
    expect(envio.entregas[0]).toMatchObject({ tempoAtivoMs: 0, aviso80Em: iso(at80), aviso100Em: null, atrasada: false })
    expect(await notice(h)).toBeNull()

    h.advance(8 * MIN) // exatamente no prazo: ainda dentro
    expect(await notice(h)).toBeNull()
    h.advance(1)
    const text = await notice(h)
    expect(text).toMatch(/^⏱ Etapa 1 \(a\): 41 de 40 min de trabalho — passou do prazo da etapa/)
    expect(text).toContain('Feche a etapa agora, corte escopo (diga o que ficou de fora) ou reporte o bloqueio')
    ;[envio] = await h.envios()
    // A marca de atraso na mesma passada (o toast do usuário sai junto); o status fica.
    expect(envio).toMatchObject({ status: 'em_execucao', atrasado: true })
    expect(envio.entregas[0]).toMatchObject({ status: 'em_andamento', aviso80Em: iso(at80), aviso100Em: iso(h.now()), atrasada: true })
    expect(h.changed.at(-1)).toBe(CONV)

    expect(await notice(h)).toBeNull()
    h.advance(60 * MIN)
    await h.tracker.sweep()
    expect(await notice(h)).toBeNull()
  })

  it('pulou direto para o estouro: só o de 100%, e o de 80% fica gravado para não vir depois', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(45 * MIN)
    expect(await notice(h)).toMatch(/^⏱ Etapa 1 \(a\): 45 de 40 min de trabalho — passou do prazo/)
    const [envio] = await h.envios()
    expect(envio.entregas[0]).toMatchObject({ aviso80Em: iso(h.now()), aviso100Em: iso(h.now()), atrasada: true })
    for (const step of [0, MIN, 30 * MIN]) {
      h.advance(step)
      expect(await notice(h)).toBeNull()
    }
  })

  it('o flush marcou o atraso antes: o aviso de 100% ainda sai, uma vez', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    const writes = recordLateWrites(h)
    h.advance(41 * MIN)
    await h.tracker.sweep()
    expect(writes).toEqual(['envio:true', 'entrega:true'])
    expect(await notice(h)).toMatch(/41 de 40 min de trabalho — passou do prazo/)
    expect(await notice(h)).toBeNull()
    expect(writes).toEqual(['envio:true', 'entrega:true'])
  })

  it('a etapa seguinte tem os próprios marcos (Etapa N = posição no prompt)', async () => {
    const h = await running(['a', 'b'], [10, 20])
    await inProgress(h, [['[a] Fazer A', 'in_progress'], ['[b] Fazer B', 'pending']])
    h.advance(9 * MIN)
    expect(await notice(h)).toMatch(/^⏱ Etapa 1 \(a\): 9 de 10 min/)
    await inProgress(h, [['[a] Fazer A', 'completed'], ['[b] Fazer B', 'in_progress']])
    h.advance(10 * MIN)
    expect(await notice(h)).toBeNull()
    h.advance(6 * MIN)
    expect(await notice(h)).toMatch(/^⏱ Etapa 2 \(b\): 16 de 20 min de trabalho — 80%/)
  })

  it('entre os marcos o hook não relê o banco; uma escrita na conversa faz reler', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    let reads = 0
    const read = h.repo.listHandoffEnvios.bind(h.repo)
    h.repo.listHandoffEnvios = async (query) => {
      reads++
      return read(query)
    }
    expect(await notice(h)).toBeNull()
    expect(reads).toBe(1)
    for (let i = 0; i < 5; i++) {
      h.advance(MIN)
      expect(await notice(h)).toBeNull()
    }
    expect(reads).toBe(1)
    await h.tracker.sweep() // grava a fatia: a conversa mudou
    const afterSweep = reads
    expect(await notice(h)).toBeNull()
    expect(reads).toBe(afterSweep + 1)
    // Mesmo com a fatia gravada, o relógio do marco continua certo.
    h.advance(32 * MIN - 5 * MIN - 1)
    expect(await notice(h)).toBeNull()
    expect(reads).toBe(afterSweep + 1)
    h.advance(1)
    expect(await notice(h)).toMatch(/80% do prazo/)
  })

  it('duas ferramentas terminando juntas: o marco sai uma vez só', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(33 * MIN)
    const texts = await Promise.all([notice(h), notice(h), notice(h)])
    expect(texts.filter(Boolean)).toHaveLength(1)
  })

  it('leitura lenta: passa do teto sem aviso, e o marco já gravado sai na próxima ferramenta', async () => {
    const h = await running(['a'], [40], await harness({ deps: { noticeTimeoutMs: 20 } }))
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(33 * MIN)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const read = h.repo.listHandoffEnvios.bind(h.repo)
    let reads = 0
    h.repo.listHandoffEnvios = async (query) => {
      reads++
      await gate
      return read(query)
    }
    const started = Date.now()
    await expect(notice(h)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
    // Com o aviso ainda na fila, as ferramentas seguintes nem esperam o teto.
    h.advance(MIN)
    await expect(notice(h)).resolves.toBeNull()
    expect(reads).toBe(1)
    h.repo.listHandoffEnvios = read
    release()
    await h.tracker.settled()
    expect((await h.envios())[0].entregas[0].aviso80Em).not.toBeNull()
    expect(await notice(h)).toMatch(/^⏱ Etapa 1 \(a\): 33 de 40 min de trabalho — 80%/)
    expect(await notice(h)).toBeNull()
  })

  it('banco falhando: null sem lançar, e o marco não se perde quando o banco volta', async () => {
    const h = await running(['a'], [40])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    h.advance(33 * MIN)
    const read = h.repo.listHandoffEnvios.bind(h.repo)
    h.repo.listHandoffEnvios = async () => {
      throw new Error('banco fora do ar')
    }
    await expect(notice(h)).resolves.toBeNull()
    expect(h.logs.some((line) => line.includes('banco fora do ar'))).toBe(true)
    h.repo.listHandoffEnvios = read
    expect(await notice(h)).toMatch(/80% do prazo/)
  })

  it('conversa não acompanhada ou sem envio: null', async () => {
    const h = await harness()
    await expect(h.tracker.deadlineNotice('outra')).resolves.toBeNull()
    await expect(notice(h)).resolves.toBeNull()
  })
})

describe('HandoffTracker — a marca de atraso não segura o fim do turno', () => {
  it('a gravação da marca falha e o fim do turno ainda é gravado; a marca sai na próxima gravação de tempo', async () => {
    const h = await running(['a'])
    await inProgress(h, [['[a] Fazer A', 'in_progress']])
    const envio = h.repo.updateHandoffEnvio.bind(h.repo)
    let failLate = true
    h.repo.updateHandoffEnvio = async (id: string, patch: HandoffEnvioPatch) => {
      if (failLate && patch.atrasado !== undefined) throw new Error('banco caiu na marca')
      return envio(id, patch)
    }

    // A etapa fecha dentro do prazo; o turno segue e passa do prazo sem varredura
    // nem snapshot: o tempo (e a marca) só é gravado no fim do turno, encadeado
    // antes do critério de conclusão.
    await inProgress(h, [['[a] Fazer A', 'completed']])
    h.advance(31 * MIN)
    h.emit(result)
    await h.settle()
    let [gravado] = await h.envios()
    expect(gravado).toMatchObject({ status: 'concluida', atrasado: false })
    expect(gravado.tempoAtivoMs).toBeGreaterThan(30 * MIN)

    // O banco voltou: a próxima gravação de tempo (retrabalho) refaz a marca.
    failLate = false
    h.emit(turnStart)
    await h.settle()
    h.advance(SEC)
    h.emit(result)
    await h.settle()
    ;[gravado] = await h.envios()
    expect(gravado).toMatchObject({ status: 'concluida', atrasado: true })
  })
})
