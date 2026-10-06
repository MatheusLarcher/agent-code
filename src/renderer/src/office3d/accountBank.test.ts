import { describe, expect, it } from 'vitest'
import type { ClaudeAccountView } from '@shared/claudeAccounts'
import type { Conversation } from '../types'
import { accountBank, busyByAccount, featuredAccount, type AccountFeed } from './accountBank'
import { DEMO_ACCOUNT, DEMO_SWITCH_MS } from './demoAccounts'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS, USAGE_BACK_AT, USAGE_OUT_AT } from './demoTimeline'
import { officePower, powerEvents } from './power'

const NOW = 1_800_000_000_000

function account(id: string, used: number | null, o: Partial<ClaudeAccountView> = {}, at = NOW - 60_000): ClaudeAccountView {
  return {
    id,
    label: id.toUpperCase(),
    email: `${id}@x.dev`,
    plan: 'max',
    rateLimitTier: null,
    status: 'connected',
    isDefault: id === 'default',
    usage: used === null ? null : { at, windows: { five_hour: { utilization: used, resetsAt: NOW + 3_600_000 }, seven_day: { utilization: 30, resetsAt: NOW + 86_400_000 } } },
    ...o
  }
}

const conv = (id: string, accountId?: string, model = 'claude-opus-4-5'): Conversation => ({ id, model, ...(accountId ? { claudeAccountId: accountId } : {}) }) as unknown as Conversation

function feed(accounts: ClaudeAccountView[], convs: Conversation[], busy: string[] = [], activeId: string | null = null): AccountFeed {
  return { claudeAccounts: accounts, conversations: convs, busyIds: new Set(busy), activeId }
}

describe('featuredAccount — a conta em destaque', () => {
  const A = account('default', 20)
  const B = account('b', 50, {}, NOW - 10_000)
  const C = account('c', 70)

  it('a que mais tem conversas ocupadas (Claude); sem claudeAccountId conta como a padrão', () => {
    const f = feed([A, B, C], [conv('1'), conv('2', 'b'), conv('3', 'b'), conv('4', 'c')], ['1', '2', '3', '4'])
    expect(busyByAccount(f).get('default')).toBe(1)
    expect(featuredAccount(f)).toBe('b')
  })

  it('empate: a de leitura mais recente', () => {
    const f = feed([A, B], [conv('1'), conv('2', 'b')], ['1', '2'])
    expect(featuredAccount(f)).toBe('b')
  })

  it('conversa GPT ou Ollama ocupada não conta; ninguém trabalhando: a da conversa aberta', () => {
    const f = feed([A, B, C], [conv('g', 'c', 'gpt-6-luna'), conv('o', 'c', 'kimi-k3:cloud'), conv('2', 'c')], ['g', 'o'], '2')
    expect(busyByAccount(f).size).toBe(0)
    expect(featuredAccount(f)).toBe('c')
  })

  it('conversa aberta em GPT: cai na 1ª conectada da ordem do usuário', () => {
    expect(featuredAccount(feed([B, A, C], [conv('g', 'c', 'gpt-6-luna')], [], 'g'))).toBe('b')
  })

  it('só as conectadas: expirada e deslogada ficam de fora, mesmo trabalhando', () => {
    const X = account('x', 10, { status: 'expired' })
    const Y = account('y', 10, { status: 'logged-out' })
    const f = feed([X, Y, A], [conv('1', 'x'), conv('2', 'x'), conv('3', 'y')], ['1', '2', '3'])
    expect(featuredAccount(f)).toBe('default')
    expect(accountBank(f, NOW).map((b) => b.id)).toEqual(['default'])
  })

  it('lista vazia (ou nenhuma conectada): null — a energia volta ao usageLimits de hoje', () => {
    expect(featuredAccount(feed([], []))).toBeNull()
    expect(featuredAccount({})).toBeNull()
    const p = officePower({ usageLimits: { five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.4, updatedAt: NOW } } }, NOW)
    expect([p?.pct, p?.accountId, p?.bank]).toEqual([60, null, []])
  })
})

describe('accountBank — o banco de baterias', () => {
  it('na ordem do usuário, com a % que resta, o nível, o reset, 7 dias, agentes e a hora da leitura', () => {
    const f = feed([account('b', 85), account('default', 10), account('n', null)], [conv('1', 'b'), conv('2', 'b')], ['1'])
    const bank = accountBank(f, NOW)
    expect(bank.map((b) => [b.id, b.name, b.pct, b.level, b.busy])).toEqual([
      ['b', 'B', 15, 'alerta', 1],
      ['default', 'DEFAULT', 90, 'cheia', 0],
      ['n', 'N', null, null, 0]
    ])
    expect(bank[0].resetsAt).toBe(NOW + 3_600_000)
    expect(bank[0].weekUsed).toBe(30)
    expect(bank[2].at).toBeNull()
  })
})

describe('officePower por conta', () => {
  it('lê a janela de 5 h da conta em destaque; sem leitura dela, luz cheia e "sem leitura"', () => {
    const p = officePower(feed([account('default', 30), account('b', 90)], [conv('1', 'b')], ['1']), NOW)
    expect([p?.accountId, p?.pct, p?.level, p?.bank.length]).toEqual(['b', 10, 'alerta', 2])
    const q = officePower(feed([account('n', null)], []), NOW)
    expect([q?.accountId, q?.pct, q?.level, q?.unread]).toEqual(['n', 100, 'cheia', true])
  })

  it('a troca de conta é outra bateria: as amostras recomeçam e sair do apagão dá "luz-voltou"', () => {
    const empty = account('default', 100)
    const full = account('r', 0)
    let p = officePower(feed([empty, full], [conv('1'), conv('2')], ['1', '2']), NOW)
    p = officePower(feed([account('default', 100, {}, NOW), full], [conv('1'), conv('2')], ['1', '2']), NOW + 60_000, p)
    expect(p?.level).toBe('apagao')
    expect(p?.samples.length).toBe(2)
    // As conversas trocam para a Reserva: o destaque muda.
    const q = officePower(feed([empty, full], [conv('1', 'r'), conv('2', 'r')], ['1', '2']), NOW + 120_000, p)
    expect(q?.accountId).toBe('r')
    expect(q?.samples.length).toBe(1)
    expect(q?.drainPerMin).toBe(0)
    expect(powerEvents(p, q)).toBe('luz-voltou')
  })

  it('com 2 contas em uso, a luz segue a de mais agentes e não pula a cada leitura', () => {
    const accounts = [account('default', 30), account('b', 90)]
    const convs = [conv('1'), conv('2'), conv('3', 'b')]
    let prev = officePower(feed(accounts, convs, ['1', '2', '3']), NOW)
    for (let i = 1; i < 10; i++) {
      const next = officePower(feed(accounts, convs, ['1', '2', '3']), NOW + i * 10_000, prev)
      expect(next?.accountId).toBe('default')
      expect(powerEvents(prev, next)).toBeNull()
      prev = next
    }
  })
})

describe('demo: 3 contas conectadas', () => {
  const T0 = 14_916_667 * DEMO_LOOP_MS
  it('a Pessoal em destaque; esgotada, as conversas passam para a Reserva (a luz volta) e no reset voltam', () => {
    const at = (t: number): string | null => officePower(demoFeed(T0 + t), T0 + t)?.accountId ?? null
    for (let t = 0; t < DEMO_LOOP_MS; t += 1_000) {
      const id = at(t)
      const inSwitch = t >= USAGE_OUT_AT + DEMO_SWITCH_MS && t < USAGE_BACK_AT
      // A Empresa só assume quando é a única com agente trabalhando (a regra: a conta que está sendo gasta).
      expect(id, `t=${t}`).toBe(inSwitch ? DEMO_ACCOUNT.reserva : DEMO_ACCOUNT.pessoal)
      // A Empresa fica em uso (agente trabalhando nela) na 1ª metade do loop.
      if (t === 10_000) expect(busyByAccount(demoFeed(T0 + t)).get(DEMO_ACCOUNT.empresa)).toBeGreaterThan(0)
    }
    expect(officePower(demoFeed(T0 + USAGE_OUT_AT + 2_000), T0 + USAGE_OUT_AT + 2_000)?.level).toBe('apagao')
    const bank = officePower(demoFeed(T0 + 10_000), T0 + 10_000)!.bank
    expect(bank.map((b) => b.name)).toEqual(['Pessoal', 'Empresa', 'Reserva'])
    expect(bank.find((b) => b.name === 'Empresa')!.pct).toBe(18)
  })
})
