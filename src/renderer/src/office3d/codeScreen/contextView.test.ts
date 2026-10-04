import { describe, expect, it } from 'vitest'
import { secretPlaceholder, type ContextBlock, type ContextTurnDetail, type ContextUsageSnapshot } from '@shared/contextSnapshot'
import { allContextText, contextBlocks, contextTotals, countHits, maskedText, secretSegments } from './contextView'

const block = (kind: ContextBlock['kind'], text: string, source: ContextBlock['source'] = 'prompt', at = 1000): ContextBlock => ({
  kind, label: kind, source, hash: `h:${text}`, bytes: new TextEncoder().encode(text).length, at, text
})

const detail = (blocks: ContextBlock[], patch: Partial<ContextTurnDetail> = {}): ContextTurnDetail => ({
  convId: 'c', turnId: 't', pc: 'PC', startedAt: 1, model: 'claude-opus-5-5', models: [], provider: 'claude', request: 'pedido',
  blockCount: blocks.length, totalBytes: 0, memoriesSent: [], complete: true, blocks, usage: null, secrets: [], ...patch
})

const usage: ContextUsageSnapshot = {
  detail: 'summary', at: 5, totalTokens: 62400, maxTokens: 200000, percentage: 31,
  categories: [{ name: 'Messages', tokens: 9800, kind: 'used' }, { name: 'Free space', tokens: 1000, kind: 'free' }],
  systemTools: [{ name: 'Bash', tokens: 2900 }, { name: 'Read', tokens: 1100 }],
  mcpTools: [{ name: 'mcp__browser__a', serverName: 'browser', tokens: 900 }, { name: 'mcp__browser__b', serverName: 'browser', tokens: 1000 }],
  systemPromptSections: [{ name: 'Base', tokens: 8000 }],
  memoryFiles: [{ path: 'C:\\p\\CLAUDE.md', type: 'Project', tokens: 1500 }],
  skills: [{ name: 'frontend-design', source: 'userSettings', tokens: 90 }]
}

describe('contextBlocks', () => {
  const turn = detail([
    block('system-append', 'instruções do app'.repeat(100), 'system'),
    block('stamp', '[Contexto do sistema]'),
    block('user-request', 'arruma o login'),
    block('docs', 'docs v1\nlinha igual', 'hook-start', 2000),
    block('memory-excerpts', '--- Memória relevante: a.md ---\nx', 'hook-start', 2000),
    block('docs', 'docs v1\nlinha igual\nlinha nova', 'hook-mid', 3000)
  ], { usage })

  it('na ordem de leitura: o motor (medido), as instruções do app, o resto do motor, o envio, os hooks e o reenvio', () => {
    const ids = contextBlocks({ detail: turn }).map((b) => b.title)
    expect(ids).toEqual([
      'Ferramentas do motor', 'Ferramentas do app (MCP)', 'Instruções internas do motor', 'Instruções do app',
      'CLAUDE.md que o motor lê', 'Skills que o motor anuncia', 'Histórico desta conversa',
      'Carimbo', 'Seu pedido', 'Docs do projeto', 'Trechos de memória', 'Docs do projeto, de novo'
    ])
  })

  it('o que o app não vê vem do SDK, sem texto; o que ele envia tem o texto exato e estimativa', () => {
    const blocks = contextBlocks({ detail: turn })
    const tools = blocks.find((b) => b.id === 'tools')!
    expect([tools.text, tools.measured, tools.tokens, tools.list]).toEqual([undefined, true, 4000, [['Bash', 2900], ['Read', 1100]]])
    expect(blocks.find((b) => b.id === 'mcp')!.list).toEqual([['browser · 2 ferramentas', 1900]])
    // O system prompt medido inclui o append do app (mostrado à parte): não conta duas vezes.
    const app = blocks.find((b) => b.title === 'Instruções do app')!
    expect(blocks.find((b) => b.id === 'engine')!.tokens).toBe(8000 - app.tokens)
    const ask = blocks.find((b) => b.title === 'Seu pedido')!
    expect([ask.text, ask.measured, ask.tokens]).toEqual(['arruma o login', false, Math.round(14 / 4)])
  })

  it('reenvio do meio do turno: com o horário e só as linhas novas marcadas', () => {
    const resend = contextBlocks({ detail: turn }).at(-1)!
    expect([resend.when, resend.added]).toEqual([3000, [2]])
  })

  it('sem medição: os blocos do motor ficam, sem tamanho e com o aviso', () => {
    const blocks = contextBlocks({ detail: { ...turn, usage: null } })
    expect(blocks[0]).toMatchObject({ measured: false, tokens: 0, note: 'A medição do SDK chega ao fim do turno.' })
  })

  it('turno antigo: bloco com o mesmo texto do turno seguinte vem marcado', () => {
    const newer = detail([block('stamp', 'outro carimbo'), block('docs', 'docs v1\nlinha igual', 'hook-start')])
    const blocks = contextBlocks({ detail: turn, newer })
    expect(blocks.filter((b) => b.same).map((b) => b.title)).toEqual(['Docs do projeto'])
  })

  it('subagente: as instruções e o pedido dele, e o motor como não visível', () => {
    const sub = detail([block('subagent-instructions', 'você é o executor', 'subagent'), block('subagent-request', 'faça X', 'subagent')])
    expect(contextBlocks({ detail: sub, subagent: true }).map((b) => [b.title, b.text !== undefined])).toEqual([
      ['Instruções do especialista', true], ['Pedido do Agent principal', true], ['O que o motor carrega para o subagente', false]
    ])
  })

  it('continuação automática: o pedido interno vira "Continuação automática" com o horário', () => {
    const cont = contextBlocks({ detail: detail([block('user-request', 'pedido'), block('user-request', 'Continue a tarefa', 'continuation', 9000)]) })
    expect(cont.at(-1)).toMatchObject({ title: 'Continuação automática', when: 9000 })
  })

  it('totais: o do SDK quando há; senão a soma estimada', () => {
    const blocks = contextBlocks({ detail: turn })
    expect(contextTotals(blocks, usage)).toMatchObject({ tokens: 62400, measured: true })
    expect(contextTotals(blocks, null).measured).toBe(false)
  })
})

describe('senhas e busca', () => {
  const text = `- vault: ${secretPlaceholder('vault')}\n- outra: ${secretPlaceholder('outra')}`
  it('separa cada senha pelo nome', () => {
    expect(secretSegments(text)).toEqual([{ text: '- vault: ' }, { secret: 'vault' }, { text: '\n- outra: ' }, { secret: 'outra' }])
  })
  it('copiar leva só o nome', () => {
    expect(maskedText(text)).toBe('- vault: [senha: vault]\n- outra: [senha: outra]')
    expect(allContextText(contextBlocks({ detail: detail([block('system-append', text, 'system')]) }))).toContain('[senha: vault]')
  })
  it('conta ocorrências sem diferenciar caixa', () => {
    expect(countHits('Memória memória MEMÓRIA', 'memória')).toBe(3)
    expect(countHits(undefined, 'x')).toBe(0)
    expect(countHits('abc', '  ')).toBe(0)
  })
})
