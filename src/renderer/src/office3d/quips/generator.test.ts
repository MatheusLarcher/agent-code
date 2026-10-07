import { afterEach, describe, expect, it, vi } from 'vitest'
import { STALL_MS, type AgentEvent, type AgentEventBody, type AgentStatus, type AgentTool, type ToolKind } from '../events'
import { QUIP_MAX } from './format'
import {
  createQuipEngine,
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  MIN_DWELL_MS,
  PRIORITY,
  REPEAT_MS,
  seededRng,
  TTL_MS,
  type Quip,
  type QuipEngine,
  type QuipKind,
  type Rng
} from './generator'
import { PROJECTOR_IDLE_MS } from '../projectorUse'

/** 14:00 local: a hora do reset sai igual em qualquer fuso. */
const NOW = new Date(2026, 9, 2, 14, 0).getTime()
const KEY = 'conv:a'

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    key: KEY, convId: 'a', role: 'principal', phase: 'working', task: true, tool: null, lastUserText: 'arruma o login', busySinceMs: NOW - 1_000,
    idleSinceMs: null, contextPct: 80, permission: null, error: null, usageExhausted: null, speaking: false, stalledMs: 0, ...over
  }
}
const tool = (name: string, kind: ToolKind, target: string, detail = '', id = `${name}:${target}`): AgentTool => ({ id, name, kind, target, detail })
const ev = (body: AgentEventBody, key = KEY): AgentEvent => ({ key, convId: 'a', at: NOW, ...body })
const toolEv = (t: AgentTool, key = KEY): AgentEvent => ev({ type: 'tool', name: t.name, kind: t.kind, target: t.target }, key)
const world = (...list: AgentStatus[]): Map<string, AgentStatus> => new Map(list.map((s) => [s.key, s]))
/** Um passo com um agente só; devolve o balão dele. */
const one = (engine: QuipEngine, s: AgentStatus, events: AgentEvent[], now: number): Quip | null => engine.step(world(s), events, now).get(s.key) ?? null
const fixed = (v: number): Rng => () => v
const idleStatus = (over: Partial<AgentStatus> = {}): AgentStatus => status({ phase: 'idle', busySinceMs: null, idleSinceMs: NOW - 5 * 60_000, ...over })

afterEach(() => vi.restoreAllMocks())

describe('createQuipEngine: prioridade', () => {
  // De cima para baixo: o de cima sempre ganha do de baixo, chegando juntos em qualquer ordem.
  const LADDER: Array<{ name: string; body: AgentEventBody; status: Partial<AgentStatus>; priority: number }> = [
    { name: 'permission', body: { type: 'permission', tool: 'Bash', detail: 'rm -rf dist' }, status: { phase: 'waiting-permission', permission: { tool: 'Bash', detail: 'rm -rf dist' } }, priority: PRIORITY.permission },
    { name: 'error', body: { type: 'error', message: 'ENOENT config.json' }, status: { error: 'ENOENT config.json' }, priority: PRIORITY.error },
    { name: 'request', body: { type: 'request', text: 'arruma o login' }, status: {}, priority: PRIORITY.request },
    { name: 'test-result', body: { type: 'test-result', passed: 42, failed: 0 }, status: {}, priority: PRIORITY.result },
    { name: 'warn', body: { type: 'context-low', pct: 15 }, status: { contextPct: 15 }, priority: PRIORITY.warn },
    { name: 'progress', body: { type: 'tool', name: 'Read', kind: 'read', target: 'api.ts' }, status: { tool: tool('Read', 'read', 'api.ts') }, priority: PRIORITY.progress }
  ]

  it('permission > error > request > done/test-result > warn > progress, no mesmo passo e em qualquer ordem', () => {
    for (let i = 0; i < LADDER.length; i++) {
      for (let j = i + 1; j < LADDER.length; j++) {
        const [hi, lo] = [LADDER[i], LADDER[j]]
        for (const order of [[hi.body, lo.body], [lo.body, hi.body]]) {
          const q = one(createQuipEngine(seededRng(i * 10 + j)), status({ ...lo.status, ...hi.status }), order.map((b) => ev(b)), NOW)
          expect(q?.priority, `${hi.name} × ${lo.name}`).toBe(hi.priority)
        }
      }
    }
  })

  it('o mais alto entra na hora; o mais baixo não derruba o que está no ar', () => {
    const e = createQuipEngine(seededRng(2))
    const bash = tool('Bash', 'bash', 'rm -rf dist')
    const working = status({ tool: bash })
    expect(one(e, working, [toolEv(bash)], NOW)?.kind).toBe('progress')
    const asking = status({ phase: 'waiting-permission', tool: bash, permission: { tool: 'Bash', detail: 'rm -rf dist' } })
    const perm = one(e, asking, [ev({ type: 'permission', tool: 'Bash', detail: 'rm -rf dist' })], NOW + 500)
    expect(perm?.kind).toBe('permission')
    expect(perm?.text).toContain('`rm -rf dist`')
    // Contexto baixo e ferramenta nova não tiram a permissão.
    const read = tool('Read', 'read', 'api.ts')
    expect(one(e, { ...asking, tool: read }, [toolEv(read), ev({ type: 'context-low', pct: 10 })], NOW + 1_000)).toBe(perm)
    // Progress tira a fala de quem estava à toa.
    const e2 = createQuipEngine(fixed(0))
    expect(one(e2, idleStatus(), [], NOW)).toBeNull()
    expect(one(e2, idleStatus(), [], NOW + IDLE_MIN_MS)?.priority).toBe(PRIORITY.idle)
    expect(one(e2, status({ tool: read }), [toolEv(read)], NOW + IDLE_MIN_MS + 100)?.kind).toBe('progress')
  })

  it('1 balão por agente: cada personagem do retrato tem a sua entrada', () => {
    const e = createQuipEngine(seededRng(4))
    const read = tool('Read', 'read', 'api.ts')
    const a = status()
    const b = status({ key: 'track:t1', role: 'executor', trackId: 't1', tool: read })
    const c = idleStatus({ key: 'po:room', role: 'po' })
    const out = e.step(world(a, b, c), [ev({ type: 'request', text: 'arruma o login' }), toolEv(read, 'track:t1')], NOW)
    expect([...out.keys()]).toEqual([KEY, 'track:t1', 'po:room'])
    expect(out.get(KEY)?.kind).toBe('request')
    expect(out.get('track:t1')?.text).toContain('api.ts')
    expect(out.get('po:room')).toBeNull()
    // Quem sai de cena recebe null uma vez e é esquecido.
    const next = e.step(world(a, c), [], NOW + 1_000)
    expect(next.has('track:t1')).toBe(true)
    expect(next.get('track:t1')).toBeNull()
    expect(e.step(world(a, c), [], NOW + 2_000).has('track:t1')).toBe(false)
  })
})

describe('createQuipEngine: cooldown e TTL', () => {
  it('progress não repete ferramenta+alvo e só troca outro progress depois de MIN_DWELL_MS', () => {
    const e = createQuipEngine(seededRng(3))
    const read1 = tool('Read', 'read', 'api.ts', '', 'r1')
    const q1 = one(e, status({ tool: read1 }), [toolEv(read1)], NOW)
    expect(q1?.text).toContain('api.ts')
    // Mesma ferramenta e alvo numa chamada nova: nada muda, nem depois do TTL.
    const read2 = tool('Read', 'read', 'api.ts', '', 'r2')
    expect(one(e, status({ tool: read2 }), [toolEv(read2)], NOW + 1_000)).toBe(q1)
    expect(one(e, status({ tool: read2 }), [], NOW + TTL_MS.progress)).toBeNull()
    // Ferramenta nova cedo demais espera; entra pelo status com o +N −M dele.
    const e2 = createQuipEngine(seededRng(3))
    const first = one(e2, status({ tool: read1 }), [toolEv(read1)], NOW)
    const edit = tool('Edit', 'edit', 'card.css', '+6 −4')
    expect(one(e2, status({ tool: edit }), [toolEv(edit)], NOW + MIN_DWELL_MS - 1)).toBe(first)
    const q2 = one(e2, status({ tool: edit }), [], NOW + MIN_DWELL_MS)
    expect(q2?.text).toMatch(/card\.css \(\+6 −4\)/)
    // Voltar ao api.ts dentro da janela não narra de novo; depois dela, sim.
    expect(one(e2, status({ tool: read2 }), [toolEv(read2)], NOW + 2 * MIN_DWELL_MS)).toBe(q2)
    const read3 = tool('Read', 'read', 'api.ts', '', 'r3')
    expect(one(e2, status({ tool: read3 }), [toolEv(read3)], NOW + REPEAT_MS + 1)?.text).toContain('api.ts')
    // Pedido novo é outro turno: o mesmo api.ts pode ser narrado de novo.
    const e3 = createQuipEngine(seededRng(3))
    one(e3, status({ tool: read1 }), [toolEv(read1)], NOW)
    expect(one(e3, status({ tool: read2 }), [toolEv(read2)], NOW + 8_000)).toBeNull()
    one(e3, status({ phase: 'done' }), [ev({ type: 'request', text: 'lê de novo' })], NOW + 10_000)
    expect(one(e3, status({ tool: read3 }), [toolEv(read3)], NOW + 20_000)?.text).toContain('api.ts')
  })

  it('idle: nada antes de 40 s, um sorteio a cada 40–120 s e só com a chance', () => {
    // rng 0: agenda em +40 s, acerta a chance e conta há quanto tempo está parado.
    const e = createQuipEngine(fixed(0))
    expect(one(e, idleStatus(), [], NOW)).toBeNull()
    expect(one(e, idleStatus(), [], NOW + IDLE_MIN_MS - 1)).toBeNull()
    const q = one(e, idleStatus(), [], NOW + IDLE_MIN_MS)
    expect(q?.kind).toBe('idle')
    expect(q?.text).toContain('5 min')
    // rng 0.99: agenda perto de 120 s e erra a chance.
    const e2 = createQuipEngine(fixed(0.99))
    one(e2, idleStatus(), [], NOW)
    for (const t of [IDLE_MIN_MS, IDLE_MAX_MS - 1_000, IDLE_MAX_MS, IDLE_MAX_MS * 2]) expect(one(e2, idleStatus(), [], NOW + t)).toBeNull()
    // Uma hora à toa, de segundo em segundo: intervalos ≥ 40 s, falas de ocioso e pensamentos.
    const e3 = createQuipEngine(seededRng(11))
    const shown: Array<{ at: number; q: Quip }> = []
    let last: Quip | null = null
    for (let t = 0; t <= 3_600_000; t += 1_000) {
      const cur = one(e3, idleStatus(), [], NOW + t)
      if (cur && cur !== last) shown.push({ at: t, q: cur })
      last = cur
    }
    expect(shown.length).toBeGreaterThan(10)
    for (let i = 1; i < shown.length; i++) expect(shown[i].at - shown[i - 1].at).toBeGreaterThanOrEqual(IDLE_MIN_MS)
    expect(new Set(shown.map((s) => s.q.kind))).toEqual(new Set(['idle', 'thought']))
    // Trabalhando, nunca.
    const busy = createQuipEngine(fixed(0))
    for (let t = 0; t <= 300_000; t += 5_000) {
      expect([undefined, 'progress']).toContain(one(busy, status({ tool: tool('Bash', 'bash', 'npm test') }), [], NOW + t)?.kind)
    }
  })

  it('TTL por tipo; permissão e erro ficam enquanto o status sustentar', () => {
    const e = createQuipEngine(seededRng(5))
    const done = status({ phase: 'done', busySinceMs: null })
    const req = one(e, done, [ev({ type: 'request', text: 'arruma o login' })], NOW)
    expect(req?.ttlMs).toBe(TTL_MS.request)
    expect(one(e, done, [], NOW + TTL_MS.request - 1)).toBe(req)
    expect(one(e, done, [], NOW + TTL_MS.request)).toBeNull()

    const bash = tool('Bash', 'bash', 'rm -rf dist')
    const asking = status({ phase: 'waiting-permission', tool: bash, permission: { tool: 'Bash', detail: 'rm -rf dist' } })
    const perm = one(e, asking, [ev({ type: 'permission', tool: 'Bash', detail: 'rm -rf dist' })], NOW)
    expect(perm?.ttlMs).toBe(Infinity)
    expect(one(e, asking, [], NOW + 3_600_000)).toBe(perm)
    // Respondida: sai a permissão, entra o "valeu" citando o comando.
    const thanks = one(e, status({ tool: bash }), [ev({ type: 'permission-done' })], NOW + 3_600_001)
    expect(thanks?.kind).toBe('progress')
    expect(thanks?.text).toContain('rm -rf dist')

    const msg = 'ENOENT config.json'
    const failed = status({ phase: 'error', busySinceMs: null, error: msg })
    const err = one(e, failed, [ev({ type: 'error', message: msg })], NOW)
    expect(err?.kind).toBe('error')
    expect(err?.ttlMs).toBe(Infinity)
    expect(one(e, failed, [], NOW + 86_400_000)).toBe(err)
    expect(one(e, status({ phase: 'done', busySinceMs: null }), [], NOW + 86_400_001)).toBeNull()

    // Sem o status confirmando, permissão vira transiente.
    const loose = one(createQuipEngine(seededRng(5)), status(), [ev({ type: 'permission', tool: 'Bash', detail: 'rm -rf dist' })], NOW)
    expect(loose?.ttlMs).toBe(TTL_MS.fallback)
  })

  it('limite de uso: a fala do limite (com a hora) toma o lugar do erro e ele não volta depois', () => {
    const e = createQuipEngine(seededRng(6))
    const resetsAt = new Date(2026, 9, 2, 23, 40).getTime()
    const msg = 'Claude AI usage limit reached'
    const out = status({ phase: 'error', busySinceMs: null, error: msg, usageExhausted: { resetsAt } })
    const q = one(e, out, [ev({ type: 'error', message: msg }), ev({ type: 'usage-exhausted', resetsAt })], NOW)
    expect(q?.kind).toBe('warn')
    expect(q?.text).toContain('23:40')
    expect(q?.ttlMs).toBe(Infinity)
    expect(one(e, out, [], NOW + 3_600_000)).toBe(q)
    const back = one(e, { ...out, usageExhausted: null }, [ev({ type: 'usage-back' })], resetsAt)
    expect(back?.kind).toBe('done')
    expect(one(e, { ...out, usageExhausted: null }, [], resetsAt + 60_000)).toBeNull()
  })
})

describe('createQuipEngine: texto', () => {
  it('≤ 72 com corte inteligente de pedido, arquivo, comando e erro', () => {
    const e = createQuipEngine(seededRng(8))
    const longAsk = 'Refatora o carrinho [mídia 1] e cobre tudo com teste e cobre tudo com teste e cobre tudo'
    const req = one(e, status(), [ev({ type: 'request', text: longAsk })], NOW)
    expect(req?.text.length).toBeLessThanOrEqual(QUIP_MAX)
    expect(req?.text).toContain('Refatora o carrinho')

    const file = 'useAuthenticationProviderWithRefresh.test.tsx'
    const edit = tool('Edit', 'edit', file, '+120 −87')
    const qe = one(createQuipEngine(seededRng(8)), status({ tool: edit }), [toolEv(edit)], NOW)
    expect(qe?.text.length).toBeLessThanOrEqual(QUIP_MAX)
    expect(qe?.text).toMatch(/\.tsx/)
    expect(qe?.text).toContain('useAuth')

    const cmd = 'node C:\\GitHub\\agent-code\\scripts\\really\\deep\\folder\\build-installer-and-sign.mjs --sign --verbose --channel=beta'
    const bash = tool('Bash', 'bash', cmd)
    const qb = one(createQuipEngine(seededRng(8)), status({ tool: bash }), [toolEv(bash)], NOW)
    expect(qb?.text.length).toBeLessThanOrEqual(QUIP_MAX)
    expect(qb?.text).toContain('node build-installer')
    expect(qb?.text).not.toContain('C:\\')

    const msg = "Error: ENOENT: no such file or directory, open 'C:\\GitHub\\agent-code\\config.json'"
    const qr = one(createQuipEngine(seededRng(8)), status({ phase: 'error', error: msg }), [ev({ type: 'error', message: msg })], NOW)
    expect(qr?.text).toContain('ENOENT config.json')
  })

  it('erro da API: a fala diz o que houve em português, com o humor de sempre e sem o JSON cru', () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    const clipped = `${raw.slice(0, 79)}…` // o corte do retrato (events.TEXT_MAX)
    const texts = new Set<string>()
    for (let seed = 1; seed <= 12; seed++) {
      const msg = seed % 2 ? raw : clipped
      const q = one(createQuipEngine(seededRng(seed)), status({ phase: 'error', busySinceMs: null, error: msg }), [ev({ type: 'error', message: msg })], NOW)
      expect(q?.kind).toBe('error')
      expect(q?.text).toContain('API sobrecarregada (529)')
      expect(q?.text).not.toMatch(/\{|"type"/)
      expect(q?.text.length).toBeLessThanOrEqual(QUIP_MAX)
      texts.add(q?.text ?? '')
    }
    expect(texts.size).toBeGreaterThan(1) // as variações (e a piada) continuam
  })

  it('variação: a mesma situação seguida não repete a frase', () => {
    const e = createQuipEngine(fixed(0))
    const a = one(e, status({ phase: 'done' }), [ev({ type: 'request', text: 'um' })], NOW)
    const b = one(e, status({ phase: 'done' }), [ev({ type: 'request', text: 'um' })], NOW + 100)
    expect(a?.text).not.toBe(b?.text)
  })

  it('determinístico: mesma seed, mesmas falas; seed diferente, outras; sem Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random é proibido no gerador')
    })
    const run = (seed: number): string[] => {
      const e = createQuipEngine(seededRng(seed))
      const out: string[] = []
      for (let i = 0; i < 30; i++) {
        const t = tool(i % 2 ? 'Read' : 'Bash', i % 2 ? 'read' : 'bash', i % 2 ? `f${i}.ts` : `npm run job${i}`)
        const at = NOW + i * 10_000
        out.push(one(e, status({ tool: t }), [toolEv(t), ev({ type: 'test-result', passed: i, failed: i % 3 })], at)?.text ?? '')
      }
      for (let t = 0; t < 1_800_000; t += 5_000) out.push(one(e, idleStatus({ key: 'po:x', role: 'po' }), [], NOW + 400_000 + t)?.text ?? '')
      return out
    }
    expect(run(7)).toEqual(run(7))
    expect(run(7)).not.toEqual(run(8))
    expect(random).not.toHaveBeenCalled()
  })
})

describe('createQuipEngine: todos os eventos falam', () => {
  const resetsAt = new Date(2026, 9, 2, 23, 40).getTime()
  const enoent = "ENOENT: no such file or directory, open 'C:\\proj\\config.json'"
  const CASES: Array<{ body: AgentEventBody; status?: Partial<AgentStatus>; kind: QuipKind; has: string | RegExp }> = [
    { body: { type: 'request', text: 'arruma o login' }, kind: 'request', has: 'arruma o login' },
    { body: { type: 'tool', name: 'Edit', kind: 'edit', target: 'card.css' }, status: { tool: tool('Edit', 'edit', 'card.css', '+6 −4') }, kind: 'progress', has: 'card.css' },
    { body: { type: 'test-result', passed: 42, failed: 0 }, kind: 'done', has: '42' },
    { body: { type: 'test-result', passed: 39, failed: 3 }, kind: 'error', has: '3' },
    { body: { type: 'permission', tool: 'Bash', detail: 'rm -rf dist' }, status: { phase: 'waiting-permission', permission: { tool: 'Bash', detail: 'rm -rf dist' } }, kind: 'permission', has: 'rm -rf dist' },
    { body: { type: 'permission-done' }, kind: 'progress', has: /\S/ },
    { body: { type: 'delegate', childKey: 'role:c:/proj/alpha:critico', description: 'revisar o checkout' }, kind: 'progress', has: /crítico.*revisar o checkout/ },
    { body: { type: 'return', childKey: 'track:t9', ok: true }, kind: 'done', has: 'subagente' },
    { body: { type: 'return', childKey: 'role:c:/proj/alpha:executor', ok: false }, kind: 'error', has: 'executor' },
    { body: { type: 'error', message: enoent }, status: { phase: 'error', error: enoent }, kind: 'error', has: 'ENOENT config.json' },
    { body: { type: 'done', summary: { edited: ['a.ts', 'b.ts'], created: ['c.ts'], commands: ['npm test'] } }, status: { phase: 'done' }, kind: 'done', has: '3 arquivos' },
    { body: { type: 'context-low', pct: 15 }, status: { contextPct: 15 }, kind: 'warn', has: '15%' },
    { body: { type: 'usage-exhausted', resetsAt }, status: { usageExhausted: { resetsAt } }, kind: 'warn', has: '23:40' },
    { body: { type: 'usage-back' }, kind: 'done', has: /limite|cota|crédito/i },
    { body: { type: 'stalled', ms: 4 * 60_000 }, status: { stalledMs: 4 * 60_000, tool: tool('Bash', 'bash', 'npm install') }, kind: 'warn', has: '4 min' },
    { body: { type: 'speaking', on: true }, status: { speaking: true }, kind: 'progress', has: /lend|narr|locutor/i },
    { body: { type: 'speaking', on: false }, kind: 'idle', has: /leitura|ler|falei/i }
  ]

  it('cobre os 14 tipos de evento', () => {
    expect(new Set(CASES.map((c) => c.body.type)).size).toBe(14)
  })

  for (const c of CASES) {
    it(`${c.body.type} → ${c.kind}`, () => {
      const q = one(createQuipEngine(seededRng(13)), status(c.status), [ev(c.body)], NOW)
      expect(q?.kind).toBe(c.kind)
      if (typeof c.has === 'string') expect(q?.text).toContain(c.has)
      else expect(q?.text).toMatch(c.has)
      expect(q?.text.length).toBeLessThanOrEqual(QUIP_MAX)
      expect(q?.convId).toBe('a')
    })
  }

  it('sem evento, o status ainda fala: ferramenta atual, "pensando", travamento e voz', () => {
    const bash = tool('Bash', 'bash', 'npm test')
    expect(one(createQuipEngine(seededRng(1)), status({ tool: bash }), [], NOW)?.text).toContain('npm test')
    const thinking = one(createQuipEngine(seededRng(1)), status({ busySinceMs: NOW - 10_000 }), [], NOW)
    expect(thinking?.kind).toBe('progress')
    expect(thinking?.text).toContain('arruma o login')
    const e = createQuipEngine(seededRng(1))
    const stuck = status({ tool: bash, stalledMs: STALL_MS + 60_000 })
    const first = one(e, stuck, [], NOW)
    expect(first?.kind).toBe('progress') // a ferramenta primeiro
    const warn = one(e, stuck, [], NOW + TTL_MS.progress)
    expect(warn?.kind).toBe('warn')
    expect(warn?.text).toMatch(/3 min/)
    expect(one(e, { ...stuck, stalledMs: 0 }, [], NOW + TTL_MS.progress + 1)).toBeNull() // voltou a dar sinal: cai
    const voice = one(createQuipEngine(seededRng(1)), status({ phase: 'done', speaking: true }), [], NOW)
    expect(voice?.kind).toBe('progress')
  })
})

describe('createQuipEngine: a fala do projetor', () => {
  it('a 1ª chamada de navegador/Android em PROJECTOR_IDLE_MS vira a fala do projetor (passa na frente da narração); depois, a narração de sempre', () => {
    const e = createQuipEngine(fixed(0))
    const read = tool('Read', 'read', 'api.ts')
    expect(one(e, status({ tool: read }), [toolEv(read)], NOW)?.priority).toBe(PRIORITY.progress)
    const nav = tool('mcp__browser__browser_navigate', 'web', 'localhost:5173')
    const screen = one(e, status({ tool: nav }), [toolEv(nav)], NOW + 500)
    expect(screen).toMatchObject({ kind: 'progress', icon: '🎬', priority: PRIORITY.screen, text: 'Testando no navegador: localhost:5173 — abrindo página 🎬' })
    // Mesmo "sessão" de testes: o próximo clique é a narração do navegador.
    const click = tool('mcp__browser__browser_click', 'web', '')
    const later = one(e, status({ tool: click }), [toolEv(click)], NOW + 10_000)
    expect(later?.icon).toBe('🧭')
    expect(later?.text).toContain('clicando')
    // Passado o intervalo sem projetor, a fala volta.
    const shot = tool('mcp__browser__browser_screenshot', 'web', '')
    expect(one(e, status({ tool: shot }), [toolEv(shot)], NOW + 500 + PROJECTOR_IDLE_MS)?.icon).toBe('🎬')
  })

  it('Android: a fala do celular, com a ação', () => {
    const tap = tool('mcp__android__android_tap', 'other', '')
    const q = one(createQuipEngine(fixed(0)), status({ tool: tap }), [toolEv(tap)], NOW)
    expect(q).toMatchObject({ icon: '📱', text: 'Testando no celular: tocando na tela 📱' })
    // A toolchain (setup, build) não liga o projetor.
    const build = tool('mcp__android__android_build_apk', 'other', '')
    expect(one(createQuipEngine(fixed(0)), status({ tool: build }), [toolEv(build)], NOW)?.icon).toBe('🛠️')
  })
})
