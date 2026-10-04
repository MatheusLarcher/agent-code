import { describe, expect, it } from 'vitest'
import type { ContextTurnSummary } from '@shared/contextSnapshot'
import type { MemoryListItem } from '@shared/memoryPanel'
import { conv } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { byFolder, filterUsage, memoryRows, NO_FILTERS, relInMemories, usageFromMessages, usageFromTurns, type UsageEvent } from './memoryUsage'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 4, 15, 0).getTime()
const MEM = 'D:\\dados\\memories'
const ok = { isError: false, text: 'ok' }
const tool = (id: string, name: string, input: unknown): UIMessage => ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: ok }) as UIMessage
const answer = (id: string, ts: number): UIMessage => ({ kind: 'text', id, text: 'feito', answer: true, ts }) as unknown as UIMessage
const item = (relPath: string, extra: Partial<MemoryListItem> = {}): MemoryListItem => ({ relPath, title: `T ${relPath}`, hook: `g ${relPath}`, folder: relPath.includes('/') ? relPath.split('/')[0] : '', scope: 'user', projectCwd: null, revision: 1, status: 'active', updatedAt: new Date(NOW - DAY).toISOString(), ...extra })
const ev = (relPath: string | null, how: UsageEvent['how'], at: number, convId = 'a', project = 'C:\\loja'): UsageEvent => ({ relPath, convId, agent: `Agente ${convId}`, project, how, at })

describe('o uso das memórias (memoryUsage)', () => {
  it('das mensagens: propose (gravada/atualizada/aposentada), memory_list (a lista), Read na pasta; o "quando" é o fim do turno', () => {
    const c = conv('a', {
      title: 'Loja',
      cwd: 'C:\\loja',
      updatedAt: NOW,
      messages: [
        tool('t1', 'mcp__memory__memory_list', {}),
        tool('t2', 'Read', { file_path: 'd:\\DADOS\\memories\\2D\\vps.md' }),
        tool('t3', 'mcp__memory__memory_propose', { op: 'update', rel_path: '2D/vps.md' }),
        answer('r1', NOW - 5000),
        tool('t4', 'mcp__memory__memory_propose', { op: 'retire', rel_path: 'velha.md' }),
        tool('t5', 'Read', { file_path: 'C:\\loja\\a.ts' }),
        { ...tool('t6', 'mcp__memory__memory_propose', { op: 'create', rel_path: 'x.md' }), result: { isError: true, text: 'falhou' } } as UIMessage
      ]
    })
    expect(usageFromMessages(c, MEM).map((e) => [e.relPath, e.how, e.at])).toEqual([
      [null, 'lida', NOW - 5000],
      ['2D/vps.md', 'lida', NOW - 5000],
      ['2D/vps.md', 'atualizada', NOW - 5000],
      ['velha.md', 'aposentada', NOW]
    ])
    expect(relInMemories('D:\\dados\\memories\\..\\fora.md', MEM)).toBeNull()
  })

  it('dos turnos do contexto: as memórias que o app escolheu', () => {
    const c = conv('a', { title: 'Loja', cwd: 'C:\\loja' })
    const turns = [{ turnId: 't', startedAt: NOW - 1000, memoriesSent: ['2D/vps.md', 'raiz.md'] }] as unknown as ContextTurnSummary[]
    expect(usageFromTurns(c, turns).map((e) => [e.relPath, e.how, e.at, e.agent])).toEqual([
      ['2D/vps.md', 'escolhida', NOW - 1000, 'Loja'],
      ['raiz.md', 'escolhida', NOW - 1000, 'Loja']
    ])
  })

  it('filtros da linha do tempo: período, como, projeto, agente, pasta, tipo e busca (a mais recente primeiro)', () => {
    const items = [item('2D/vps.md', { scope: 'project' }), item('raiz.md')]
    const events = [ev('2D/vps.md', 'escolhida', NOW - 2 * 60_000), ev('raiz.md', 'gravada', NOW - 3 * DAY, 'b', 'C:\\api'), ev('raiz.md', 'atualizada', NOW - 10 * DAY), ev(null, 'lida', NOW - 60_000)]
    const ids = (f: Partial<typeof NO_FILTERS>) => filterUsage(events, items, { ...NO_FILTERS, ...f }, NOW).map((e) => `${e.relPath}:${e.how}`)
    expect(ids({})).toEqual(['null:lida', '2D/vps.md:escolhida', 'raiz.md:gravada', 'raiz.md:atualizada'])
    expect(ids({ period: 'agora' })).toEqual(['null:lida', '2D/vps.md:escolhida'])
    expect(ids({ period: '7d', how: 'gravada' })).toEqual(['raiz.md:gravada'])
    expect(ids({ project: 'C:\\api' })).toEqual(['raiz.md:gravada'])
    expect(ids({ agent: 'a', folder: '2D' })).toEqual(['2D/vps.md:escolhida'])
    expect(ids({ scope: 'project' })).toEqual(['2D/vps.md:escolhida'])
    expect(ids({ text: 'vps' })).toEqual(['2D/vps.md:escolhida'])
  })

  it('todas as memórias: uso, barrinha dos 7 dias, ordem, Esquecidas, Em conflito e busca no corpo; agrupadas pela pasta', () => {
    const items = [item('2D/vps.md'), item('raiz.md'), item('nunca.md'), item('2D/velha.md')]
    const events = [ev('2D/vps.md', 'lida', NOW - 60_000), ev('2D/vps.md', 'escolhida', NOW - DAY), ev('raiz.md', 'lida', NOW - 2 * 60_000), ev('2D/velha.md', 'lida', NOW - 40 * DAY)]
    const rows = (f: Partial<typeof NO_FILTERS>, conflicts = new Set<string>(), bodies = new Map<string, string>()) => memoryRows(items, events, { ...NO_FILTERS, ...f }, NOW, conflicts, bodies)
    const vps = rows({}).find((r) => r.relPath === '2D/vps.md')!
    expect([vps.uses, vps.week]).toEqual([2, [0, 0, 0, 0, 0, 1, 1]])
    expect(rows({}).map((r) => r.relPath)).toEqual(['2D/vps.md', 'raiz.md', '2D/velha.md', 'nunca.md'])
    expect(rows({ sort: 'mais-usadas' })[0].relPath).toBe('2D/vps.md')
    expect(rows({ sort: 'nunca' })[0].relPath).toBe('nunca.md')
    expect(rows({ chip: 'esquecidas' }).map((r) => r.relPath).sort()).toEqual(['2D/velha.md', 'nunca.md'])
    expect(rows({ chip: 'conflito' }, new Set(['raiz.md'])).map((r) => r.relPath)).toEqual(['raiz.md'])
    expect(rows({ text: 'segredo' }, new Set(), new Map([['nunca.md', 'o {{secret:x}} segredo']])).map((r) => r.relPath)).toEqual(['nunca.md'])
    expect(rows({ period: 'hoje' }).map((r) => r.relPath)).toEqual(['2D/vps.md', 'raiz.md'])
    expect(byFolder(rows({})).map((g) => [g.folder, g.rows.length])).toEqual([['', 2], ['2D', 2]])
  })
})
