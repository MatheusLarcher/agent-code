// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { planProgress } from '../../shared/stepProgress'
import {
  deadlineNoticeFor,
  deadlineNoticeText,
  isLate,
  lateMarks,
  msToNextMark,
  noticeEntrega,
  rememberPlanSteps,
  withNotice,
  withTimeAdded,
  withTimeout
} from './handoffDeadline'
import { PLAN_POSITIONS_TTL_MS, PlanPositions, sessionDeadlineNotice } from './handoffDeadlineHook'
import { entrega, envio, iso, T0 } from './handoffTestKit'

// O prazo por etapa, puro: atraso só na virada e o aviso ao agente uma vez por
// marco (80% inclusive; 100% = passar do prazo, a regra do indicador da tela).

const MIN = 60_000
const AT = iso(T0)

/** Envio de uma etapa em andamento com prazo `prazo` e `ms` de tempo ativo. */
function running(ms: number, over: Parameters<typeof entrega>[0] = {}, prazo: number | null = 40) {
  const e = entrega({ etapaId: 'prazos', ordem: 1, status: 'em_andamento', estimativaPlano: prazo, tempoAtivoMs: ms, ...over })
  return envio({ estimativaTotal: prazo, prazoTotal: prazo, tempoAtivoMs: ms, entregas: [e] })
}

describe('isLate — tempo ativo acima do prazo', () => {
  it('exatamente no prazo ainda é dentro; 1 ms além já atrasa; sem prazo, nunca', () => {
    expect(isLate(40 * MIN, 40)).toBe(false)
    expect(isLate(40 * MIN + 1, 40)).toBe(true)
    expect(isLate(10_000 * MIN, null)).toBe(false)
    expect(isLate(10 * MIN, 0)).toBe(false)
  })
})

describe('withTimeAdded — a fatia somada sem reler o banco', () => {
  it('soma no envio e nas entregas da fatia; fatia de outro envio não muda nada', () => {
    const base = envio({ tempoAtivoMs: 1_000, entregas: [entrega({ id: 'hn-a', tempoAtivoMs: 500 }), entrega({ id: 'hn-b', etapaId: 'b' })] })
    const out = withTimeAdded(base, { envioId: base.id, ativoMs: 2_000, entregas: [{ id: 'hn-a', ativoMs: 2_000 }] })
    expect(out.tempoAtivoMs).toBe(3_000)
    expect(out.entregas.map((e) => e.tempoAtivoMs)).toEqual([2_500, 0])
    expect(base.tempoAtivoMs).toBe(1_000)
    expect(withTimeAdded(base, { envioId: 'outro', ativoMs: 9 })).toBe(base)
    expect(withTimeAdded(base, null)).toBe(base)
    const re = withTimeAdded(base, { envioId: base.id, retrabalhoMs: 700, entregas: [{ id: 'hn-b', retrabalhoMs: 700 }] })
    expect(re).toMatchObject({ tempoAtivoMs: 1_000, retrabalhoMs: 700 })
    expect(re.entregas[1]).toMatchObject({ tempoAtivoMs: 0, retrabalhoMs: 700 })
  })
})

describe('lateMarks — só a virada falso → verdadeiro, nunca o status', () => {
  it('entrega e envio acima do prazo viram atrasados; o patch só tem a marca', () => {
    const marks = lateMarks(running(41 * MIN))
    expect(marks).toEqual({ envio: { atrasado: true }, entregas: [{ id: 'hn-prazos', patch: { atrasada: true } }] })
  })

  it('já marcados, dentro do prazo ou sem prazo: nada a gravar', () => {
    const marked = running(50 * MIN, { atrasada: true })
    expect(lateMarks({ ...marked, atrasado: true })).toEqual({ envio: null, entregas: [] })
    expect(lateMarks(running(40 * MIN))).toEqual({ envio: null, entregas: [] })
    expect(lateMarks(running(500 * MIN, {}, null))).toEqual({ envio: null, entregas: [] })
  })

  it('o envio conta pelo prazo TOTAL: cada etapa no prazo, a soma estourada', () => {
    const a = entrega({ id: 'hn-a', etapaId: 'a', estimativaPlano: 20, tempoAtivoMs: 20 * MIN, status: 'concluida' })
    const b = entrega({ id: 'hn-b', etapaId: 'b', ordem: 2, estimativaPlano: 20, tempoAtivoMs: 15 * MIN })
    // 5 min sem etapa em andamento (entre uma e outra) também são tempo ativo do envio.
    const marks = lateMarks(envio({ prazoTotal: 40, tempoAtivoMs: 41 * MIN, entregas: [a, b] }))
    expect(marks).toEqual({ envio: { atrasado: true }, entregas: [] })
  })
})

describe('deadlineNoticeFor — o aviso ao agente, uma vez por marco', () => {
  it('abaixo de 80%: nada', () => {
    expect(deadlineNoticeFor(running(32 * MIN - 1), AT)).toBeNull()
  })

  it('80% (inclusive): o texto do marco e só o aviso_80_em', () => {
    const notice = deadlineNoticeFor(running(32 * MIN), AT)
    expect(notice).toEqual({
      entregaId: 'hn-prazos',
      mark: 80,
      text: expect.stringMatching(/^⏱ Etapa 1 \(prazos\): 32 de 40 min de trabalho — 80% do prazo/),
      patch: { aviso80Em: AT }
    })
  })

  it('80% já avisado e ainda no prazo (inclusive o exato): nada', () => {
    expect(deadlineNoticeFor(running(34 * MIN, { aviso80Em: AT }), AT)).toBeNull()
    expect(deadlineNoticeFor(running(40 * MIN, { aviso80Em: AT }), AT)).toBeNull()
  })

  it('passou do prazo: o de 100% pede fechar, cortar escopo ou reportar o bloqueio, e marca o atraso junto', () => {
    const notice = deadlineNoticeFor(running(40 * MIN + 1, { aviso80Em: '2026-10-05T11:00:00.000Z' }), AT)
    expect(notice?.mark).toBe(100)
    expect(notice?.patch).toEqual({ aviso100Em: AT, atrasada: true })
    expect(notice?.text).toMatch(/^⏱ Etapa 1 \(prazos\): 41 de 40 min de trabalho — passou do prazo/)
    expect(notice?.text).toContain('Feche a etapa')
    expect(notice?.text).toContain('corte escopo')
    expect(notice?.text).toContain('reporte o bloqueio')
    expect(notice?.text).toContain('Ninguém vai interromper você')
  })

  it('pulou direto para o estouro: só o de 100%, gravando também o de 80% (não vem depois)', () => {
    const before = running(55 * MIN)
    const notice = deadlineNoticeFor(before, AT)
    expect(notice).toMatchObject({ mark: 100, patch: { aviso80Em: AT, aviso100Em: AT, atrasada: true } })
    const after = withNotice(before, notice)
    expect(deadlineNoticeFor(after, AT)).toBeNull()
    expect(deadlineNoticeFor(withTimeAdded(after, { envioId: after.id, ativoMs: 60 * MIN, entregas: [{ id: 'hn-prazos', ativoMs: 60 * MIN }] }), AT)).toBeNull()
  })

  it('já atrasada (pelo flush) recebe o de 100% sem regravar a marca', () => {
    expect(deadlineNoticeFor(running(45 * MIN, { aviso80Em: AT, atrasada: true }), AT)?.patch).toEqual({ aviso100Em: AT })
  })

  it('etapa sem estimativa, todas concluídas, ou envio concluído: nunca', () => {
    expect(deadlineNoticeFor(running(500 * MIN, {}, null), AT)).toBeNull()
    expect(deadlineNoticeFor(running(500 * MIN, { status: 'concluida' }), AT)).toBeNull()
    expect(deadlineNoticeFor({ ...running(500 * MIN), status: 'concluida' }, AT)).toBeNull()
  })

  it('sem etapa em andamento, a atual (pendente) recebe o aviso: é para ela que o tempo vai', () => {
    expect(deadlineNoticeFor(running(500 * MIN, { status: 'pendente' }), AT)?.mark).toBe(100)
  })

  it('o texto é curto (uma linha) — vai no resultado de uma ferramenta', () => {
    for (const mark of [80, 100] as const) {
      const text = deadlineNoticeText(running(41 * MIN).entregas[0], mark, 12)
      expect(text).toMatch(/^⏱ Etapa 12 \(prazos\)/)
      expect(text).not.toContain('\n')
      expect(text.length).toBeLessThan(260)
    }
  })
})

describe('"⏱ Etapa N": N é a posição da etapa no PLANO (a mesma das telas)', () => {
  const a = entrega({ id: 'hn-a', etapaId: 'a', ordem: 1, status: 'concluida', tempoAtivoMs: 90 * MIN })
  const b = entrega({ id: 'hn-b', etapaId: 'b', ordem: 2, status: 'em_andamento', estimativaPlano: 10, tempoAtivoMs: 8 * MIN })

  it('a etapa é a ATUAL; sem posição publicada, N pela união das entregas (planProgress sem roteiro)', () => {
    const e = envio({ planSlug: 'nada-publicado', entregas: [a, b] })
    expect(noticeEntrega(e)?.id).toBe('hn-b')
    expect(deadlineNoticeFor(e, AT)?.text).toMatch(/^⏱ Etapa 2 \(b\): 8 de 10 min de trabalho/)
  })

  it('com as posições publicadas do plano (roteiro + envios, pelo hook): a dela no plano', () => {
    rememberPlanSteps('c:\\proj\\', 'publicado', [
      { id: 'base', n: 1 },
      { id: 'a', n: 2 },
      { id: 'tela', n: 3 },
      { id: 'b', n: 4 }
    ])
    // O caminho do projeto bate sem caixa nem barras (como planEnviosOf).
    const e = envio({ projectCwd: 'C:/proj', planSlug: 'publicado', entregas: [a, b] })
    expect(deadlineNoticeFor(e, AT)?.text).toMatch(/^⏱ Etapa 4 \(b\): 8 de 10 min/)
    // Outro plano não herda; etapa fora das publicadas (envio novo depois da leitura) cai na união.
    expect(deadlineNoticeFor({ ...e, planSlug: 'outro-plano' }, AT)?.text).toMatch(/^⏱ Etapa 2 \(b\)/)
    const c = { ...b, id: 'hn-c', etapaId: 'c' }
    expect(deadlineNoticeFor({ ...e, entregas: [a, c] }, AT)?.text).toMatch(/^⏱ Etapa 2 \(c\)/)
  })
})

describe('msToNextMark — quanto relógio, no mínimo, até o próximo aviso', () => {
  it('até 80%, depois até passar de 100%, depois nenhum', () => {
    expect(msToNextMark(running(10 * MIN))).toBe(22 * MIN)
    expect(msToNextMark(running(32 * MIN))).toBe(0)
    expect(msToNextMark(running(34 * MIN, { aviso80Em: AT }))).toBe(6 * MIN + 1)
    expect(msToNextMark(running(41 * MIN, { aviso80Em: AT }))).toBe(0)
    expect(msToNextMark(running(41 * MIN, { aviso80Em: AT, aviso100Em: AT }))).toBeNull()
    expect(msToNextMark(running(10 * MIN, {}, null))).toBeNull()
    expect(msToNextMark(running(10 * MIN, { status: 'pendente' }))).toBe(22 * MIN)
    expect(msToNextMark(running(10 * MIN, { status: 'concluida' }))).toBeNull()
  })
})

describe('withTimeout', () => {
  it('devolve o trabalho rápido; o lento vira null no teto, avisando quem chamou', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, () => undefined)).resolves.toBe('ok')
    const onTimeout = vi.fn()
    let release!: (v: string) => void
    const slow = new Promise<string>((resolve) => (release = resolve))
    await expect(withTimeout(slow, 5, onTimeout)).resolves.toBeNull()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    release('tarde')
  })
})

describe('sessionDeadlineNotice — só a conversa de handoff, só o fio principal, nunca lança', () => {
  const tracker = (text: string | null) => ({ deadlineNotice: vi.fn(async () => text), currentEnvio: vi.fn(async () => null) })

  it('handoff: pergunta ao acompanhamento pela conversa da sessão', async () => {
    const t = tracker('⏱ aviso')
    await expect(sessionDeadlineNotice({ convId: 'c1', handoff: { slug: 'p' } }, undefined, () => t)).resolves.toBe('⏱ aviso')
    expect(t.deadlineNotice).toHaveBeenCalledWith('c1')
  })

  it('conversa comum, Agent Manager e subagente: nem pergunta (nem lê as posições do plano)', async () => {
    const t = tracker('⏱ aviso')
    await expect(sessionDeadlineNotice({ convId: 'c1' }, undefined, () => t)).resolves.toBeNull()
    await expect(sessionDeadlineNotice({ convId: 'c1', planning: { slug: 'p' }, handoff: { slug: 'p' } }, undefined, () => t)).resolves.toBeNull()
    await expect(sessionDeadlineNotice({ convId: 'c1', handoff: { slug: 'p' } }, 'agent-7', () => t)).resolves.toBeNull()
    expect(t.deadlineNotice).not.toHaveBeenCalled()
    expect(t.currentEnvio).not.toHaveBeenCalled()
  })

  it('sem acompanhamento, ou ele falhando: null', async () => {
    const role = { convId: 'c1', handoff: { slug: 'p' } }
    await expect(sessionDeadlineNotice(role, undefined, () => null)).resolves.toBeNull()
    const boom = { deadlineNotice: vi.fn(async () => Promise.reject(new Error('banco fora'))), currentEnvio: vi.fn(async () => null) }
    await expect(sessionDeadlineNotice(role, undefined, () => boom)).resolves.toBeNull()
    await expect(
      sessionDeadlineNotice(role, undefined, () => {
        throw new Error('getter')
      })
    ).resolves.toBeNull()
  })
})

describe('PlanPositions — a posição no plano é lida FORA do caminho quente do hook', () => {
  const roteiro = [
    { id: 'base', titulo: 'Base' },
    { id: 'b', titulo: 'B' }
  ]
  const atual = (slug: string) =>
    envio({ planSlug: slug, entregas: [entrega({ id: 'hn-b', etapaId: 'b', status: 'em_andamento', estimativaPlano: 10, tempoAtivoMs: 8 * MIN })] })

  it('publica as posições do plano (o aviso seguinte numera por elas) e só relê depois do TTL', async () => {
    let now = 1_000
    const cur = atual('com-ttl')
    const load = vi.fn(async (e: typeof cur) => planProgress([e], roteiro))
    const positions = new PlanPositions({ load, now: () => now })
    const t = { currentEnvio: vi.fn(async () => cur) }

    expect(deadlineNoticeFor(cur, AT)?.text).toMatch(/^⏱ Etapa 1 \(b\)/)
    await positions.refresh('c1', t)
    expect(t.currentEnvio).toHaveBeenCalledWith('c1')
    expect(deadlineNoticeFor(cur, AT)?.text).toMatch(/^⏱ Etapa 2 \(b\)/)

    // Dentro do TTL o hook só compara o relógio: nem pergunta pelo envio.
    now += PLAN_POSITIONS_TTL_MS - 1
    expect(positions.refresh('c1', t)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    now += 1
    await positions.refresh('c1', t)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('o aviso não espera a leitura: com ela pendurada, sai na hora (e a leitura não se repete em paralelo)', async () => {
    const load = vi.fn(() => new Promise<never>(() => undefined))
    const positions = new PlanPositions({ load, now: () => 0 })
    const t = { deadlineNotice: vi.fn(async () => '⏱ aviso'), currentEnvio: vi.fn(async () => atual('pendurado')) }
    const role = { convId: 'c-lento', handoff: { slug: 'pendurado' } }
    await expect(sessionDeadlineNotice(role, undefined, () => t, positions)).resolves.toBe('⏱ aviso')
    // Nada da leitura roda no caminho da ferramenta: ela começa depois do hook.
    expect(t.currentEnvio).not.toHaveBeenCalled()
    await expect(sessionDeadlineNotice(role, undefined, () => t, positions)).resolves.toBe('⏱ aviso')
    await new Promise((resolve) => setImmediate(resolve))
    expect(t.currentEnvio).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('sem envio, ou a leitura falhando: nada publicado, nada lançado (o aviso numera pela união das entregas)', async () => {
    const cur = atual('falha')
    const sem = new PlanPositions({ load: vi.fn(), now: () => 0 })
    await expect(sem.refresh('c1', { currentEnvio: async () => null })).resolves.toBeUndefined()
    const quebrada = new PlanPositions({ load: async () => Promise.reject(new Error('disco')), now: () => 0 })
    await expect(quebrada.refresh('c1', { currentEnvio: async () => cur })).resolves.toBeUndefined()
    const semTracker = new PlanPositions({ load: vi.fn(), now: () => 0 })
    await expect(semTracker.refresh('c1', { currentEnvio: async () => Promise.reject(new Error('banco')) })).resolves.toBeUndefined()
    expect(deadlineNoticeFor(cur, AT)?.text).toMatch(/^⏱ Etapa 1 \(b\)/)
  })
})
