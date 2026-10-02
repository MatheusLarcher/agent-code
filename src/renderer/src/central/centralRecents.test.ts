import { describe, expect, it } from 'vitest'
import type { CentralEntry, CentralReplyEntry, CentralRequestEntry } from '@shared/central'
import type { Conversation } from '../types'
import { centralColor } from './centralColor'
import {
  conversationTarget,
  heuristicOptions,
  labelFor,
  recentDestinations,
  routeText,
  sameTarget
} from './centralRecents'

/**
 * O que a Central sabe dos destinos (puro): os recentes que o decisor vê como
 * candidatos a "continua" (inclusive os turnos adotados), as opções de heurística
 * quando o IPC falha, o destino de uma conversa e o rótulo projeto · conversa.
 */

const ROOT = 'C:\\local\\sandbox'

const conv = (id: string, cwd: string, title: string): Conversation =>
  ({ id, cwd, title, model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1 }) as Conversation

const convs = new Map(
  [
    conv('a1', 'C:\\proj\\alpha', 'Filtros'),
    conv('a2', 'C:\\proj\\alpha', 'Login'),
    conv('b1', 'C:\\proj\\beta', 'Relatório'),
    conv('s1', `${ROOT}\\2026-10-02_10-00_abcd`, 'Dólar')
  ].map((c) => [c.id, c])
)

let seq = 0
const sent = (convId: string, text: string, extra: Partial<CentralRequestEntry> = {}): CentralRequestEntry => ({
  kind: 'request',
  id: `r${++seq}`,
  ts: seq,
  text,
  state: 'delivered',
  anchor: { convId, msgId: `u${seq}` },
  ...extra
})
const answered = (req: CentralRequestEntry, answer?: string, notes: string[] = []): CentralReplyEntry => ({
  kind: 'reply',
  id: `reply:${req.id}`,
  ts: req.ts + 1,
  requestId: req.id,
  anchor: req.anchor!,
  notes,
  ...(answer ? { answer } : {}),
  activity: { segments: [], text: '', count: 0, errors: 0 },
  done: true
})

describe('conversationTarget', () => {
  it('projeto = nome da pasta; no sandbox, "sandbox"', () => {
    expect(conversationTarget(convs.get('a1')!, ROOT)).toEqual({ kind: 'conversation', convId: 'a1', cwd: 'C:\\proj\\alpha', project: 'alpha', title: 'Filtros', sandbox: false })
    expect(conversationTarget(convs.get('s1')!, ROOT)).toMatchObject({ project: 'sandbox', sandbox: true })
  })
})

describe('recentDestinations', () => {
  it('até 5 destinos distintos, do mais recente; pedido e começo da resposta cortados', () => {
    const r1 = sent('a1', 'arruma o filtro')
    const r2 = sent('b1', 'gera o relatório')
    const r3 = sent('a1', 'o botão ficou torto {{midia:1}}', { attachments: ['tela.png'] })
    const entries: CentralEntry[] = [r1, answered(r1, 'Filtro arrumado.'), r2, answered(r2, undefined, ['lendo', 'quase']), r3]
    expect(recentDestinations(entries, convs)).toEqual([
      { convId: 'a1', request: 'o botão ficou torto [mídia 1]', replyStart: '', cwd: 'C:\\proj\\alpha', title: 'Filtros' },
      { convId: 'b1', request: 'gera o relatório', replyStart: 'quase', cwd: 'C:\\proj\\beta', title: 'Relatório' }
    ])
  })

  it('inclui os turnos adotados (A1), ignora pedido sem âncora e a Central; para em 5', () => {
    const entries: CentralEntry[] = [
      sent('c1', 'um'),
      sent('c2', 'dois', { origin: 'conversation' }),
      sent('central', 'nunca'),
      { kind: 'request', id: 'w', ts: 99, text: 'esperando', state: 'asking' },
      sent('c3', 'três'),
      sent('c4', 'quatro'),
      sent('c5', 'cinco'),
      sent('c6', 'seis')
    ]
    const ids = recentDestinations(entries, convs).map((r) => r.convId)
    expect(ids).toEqual(['c6', 'c5', 'c4', 'c3', 'c2'])
    // Conversa não carregada vai sem pasta/título (o decisor procura no índice).
    expect(recentDestinations(entries, convs)[0]).toEqual({ convId: 'c6', request: 'seis', replyStart: '' })
  })

  it('texto longo vai cortado em ~200', () => {
    const r = sent('a1', 'x'.repeat(500))
    const [recent] = recentDestinations([r, answered(r, 'y'.repeat(500))], convs)
    expect(recent.request.length).toBeLessThanOrEqual(200)
    expect(recent.replyStart.length).toBeLessThanOrEqual(200)
  })
})

describe('heuristicOptions (IPC fora)', () => {
  it('recentes (≤ 3), nova no projeto do último destino e sandbox novo', () => {
    const recents = [
      { convId: 'a1', request: '', replyStart: '' },
      { convId: 'b1', request: '', replyStart: '' },
      { convId: 'naocarregada', request: '', replyStart: '' },
      { convId: 's1', request: '', replyStart: '' },
      { convId: 'a2', request: '', replyStart: '' }
    ]
    const opts = heuristicOptions(recents, convs, ROOT).map((o) => o.target)
    expect(opts).toEqual([
      conversationTarget(convs.get('a1')!, ROOT),
      conversationTarget(convs.get('b1')!, ROOT),
      conversationTarget(convs.get('s1')!, ROOT),
      { kind: 'new-conversation', cwd: 'C:\\proj\\alpha', project: 'alpha' },
      { kind: 'new-sandbox' }
    ])
  })

  it('último destino no sandbox: sem "nova em"; o excluído sai', () => {
    const recents = [{ convId: 's1', request: '', replyStart: '' }, { convId: 'a1', request: '', replyStart: '' }]
    const exclude = conversationTarget(convs.get('a1')!, ROOT)
    expect(heuristicOptions(recents, convs, ROOT, exclude).map((o) => o.target)).toEqual([
      conversationTarget(convs.get('s1')!, ROOT),
      { kind: 'new-sandbox' }
    ])
    expect(heuristicOptions([], convs, ROOT, { kind: 'new-sandbox' })).toEqual([])
  })
})

describe('sameTarget / routeText', () => {
  it('conversa pelo id, nova pela pasta, sandbox novo pelo tipo', () => {
    expect(sameTarget({ kind: 'new-sandbox' }, { kind: 'new-sandbox' })).toBe(true)
    expect(sameTarget({ kind: 'new-conversation', cwd: 'a', project: 'a' }, { kind: 'new-conversation', cwd: 'a', project: 'x' })).toBe(true)
    expect(sameTarget(conversationTarget(convs.get('a1')!, ROOT), conversationTarget(convs.get('a2')!, ROOT))).toBe(false)
  })

  it('texto legível para o decisor; só anexos vira a lista dos nomes', () => {
    expect(routeText('veja {{midia:1}}', ['tela.png'])).toBe('veja [mídia 1]')
    expect(routeText('   ', ['tela.png', 'plano.pdf'])).toBe('[anexos: tela.png, plano.pdf]')
    expect(routeText('x'.repeat(30_000), []).length).toBe(20_000)
  })
})

describe('labelFor', () => {
  it('projeto, título, cor e ícone (sandbox sem ícone); fora da tela, o último destino gravado', () => {
    const icons = { 'C:\\proj\\alpha': 'data:image/png;base64,AAA' }
    expect(labelFor('a1', convs, [], icons, ROOT)).toEqual({ project: 'alpha', title: 'Filtros', color: centralColor('a1'), icon: icons['C:\\proj\\alpha'], sandbox: false })
    expect(labelFor('s1', convs, [], icons, ROOT)).toMatchObject({ project: 'sandbox', icon: null, sandbox: true })
    const gone = sent('zz', 'oi', { route: { target: { kind: 'conversation', convId: 'zz', cwd: 'C:\\proj\\gama', project: 'gama', title: 'Antiga', sandbox: false }, why: '' } })
    expect(labelFor('zz', convs, [gone], icons, ROOT)).toEqual({ project: 'gama', title: 'Antiga', color: centralColor('zz'), icon: null, sandbox: false })
    expect(labelFor('nada', convs, [], icons, ROOT)).toMatchObject({ project: '', title: 'conversa', sandbox: false })
  })
})
