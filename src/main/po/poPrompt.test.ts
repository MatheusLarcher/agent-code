// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BoardItem } from '../../shared/ipc'
import {
  buildPoDigest,
  buildPoPrompt,
  parsePoVerdict,
  PO_MAX_CALLS,
  PO_MAX_OPS,
  rejectUnsafeOps,
  summarizeCall
} from './poPrompt'

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'c',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'add board table',
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

describe('digest', () => {
  it('leva pedido, quadro e ações — e respeita os tetos', () => {
    const digest = buildPoDigest({
      userText: 'faz o quadro',
      cards: [{ id: 'bi-1', title: 'uma', status: 'pending' }],
      calls: Array.from({ length: PO_MAX_CALLS + 5 }, (_, i) => ({ tool: 'Edit', detail: `arquivo${i}.ts` }))
    })
    expect(digest).toContain('faz o quadro')
    expect(digest).toContain('bi-1 [a fazer] uma')
    expect(digest).toContain('arquivo0.ts')
    expect(digest).not.toContain(`arquivo${PO_MAX_CALLS}.ts`)
  })

  it('quadro vazio e sem ações não viram string quebrada', () => {
    const digest = buildPoDigest({ userText: '', cards: [], calls: [] })
    expect(digest).toContain('(vazio)')
    expect(digest).toContain('(nenhuma)')
  })

  it('o prompt carrega as regras e o digest', () => {
    const prompt = buildPoPrompt({ userText: 'x', cards: [], calls: [] })
    expect(prompt).toContain('CONCLUIR')
    expect(prompt).toContain('PEDIDO DO USUÁRIO')
  })
})

describe('summarizeCall', () => {
  it('devolve o ALVO da ação, nunca o conteúdo do arquivo', () => {
    expect(summarizeCall('Edit', { file_path: 'src/a.ts', new_string: 'SEGREDO' })).toBe('src/a.ts')
    expect(summarizeCall('Write', { file_path: 'src/b.ts', content: 'SEGREDO' })).not.toContain('SEGREDO')
    expect(summarizeCall('Bash', { command: 'npm test' })).toBe('npm test')
  })

  it('sem alvo reconhecível o detalhe fica vazio, mas o digest ainda nomeia a ferramenta', () => {
    // O resumo é o mesmo do vigia (reusado de propósito): ferramenta sem alvo
    // conhecido devolve ''. A informação não se perde porque a linha do digest
    // é `- <ferramenta>: <detalhe>`.
    expect(summarizeCall('Alguma', {})).toBe('')
    const digest = buildPoDigest({
      userText: 'x',
      cards: [],
      calls: [{ tool: 'Alguma', detail: summarizeCall('Alguma', {}) }]
    })
    expect(digest).toContain('- Alguma:')
  })
})

describe('parsePoVerdict', () => {
  const ids = ['bi-1', 'bi-2']

  it('OK não vira operação nenhuma', () => {
    expect(parsePoVerdict('OK', ids)).toEqual([])
  })

  it('lê as três operações', () => {
    const ops = parsePoVerdict(
      ['CONCLUIR bi-1 | o arquivo foi escrito e o teste passou', 'TITULO bi-2 | Criar a tabela do quadro', 'NOVA | Documentar o PO | o agente disse que falta'].join('\n'),
      ids
    )
    expect(ops).toEqual([
      { kind: 'complete', id: 'bi-1', reason: 'o arquivo foi escrito e o teste passou' },
      { kind: 'retitle', id: 'bi-2', title: 'Criar a tabela do quadro' },
      { kind: 'create', title: 'Documentar o PO', reason: 'o agente disse que falta' }
    ])
  })

  it('id que não está no quadro é DESCARTADO — o PO não mexe no que não viu', () => {
    expect(parsePoVerdict('CONCLUIR bi-inventado | terminou', ids)).toEqual([])
  })

  it('linha malformada some sem derrubar as outras', () => {
    const ops = parsePoVerdict(
      ['isso aqui é prosa solta', 'CONCLUIR bi-1', 'CONCLUIR bi-1 | terminou de verdade'].join('\n'),
      ids
    )
    expect(ops).toEqual([{ kind: 'complete', id: 'bi-1', reason: 'terminou de verdade' }])
  })

  it('operação sem motivo é descartada — correção sem rastro não entra', () => {
    expect(parsePoVerdict('CONCLUIR bi-1 |   ', ids)).toEqual([])
    expect(parsePoVerdict('NOVA | Só o título |  ', ids)).toEqual([])
  })

  it('aceita a resposta cercada em crase ou com marcador de lista', () => {
    expect(parsePoVerdict('- CONCLUIR bi-1 | pronto', ids)).toHaveLength(1)
    expect(parsePoVerdict('```\nCONCLUIR bi-1 | pronto\n```', ids)).toHaveLength(1)
  })

  it('não repete a mesma operação no mesmo cartão', () => {
    const ops = parsePoVerdict('CONCLUIR bi-1 | a\nCONCLUIR bi-1 | b', ids)
    expect(ops).toHaveLength(1)
  })

  it('respeita o teto de operações', () => {
    const many = Array.from({ length: PO_MAX_OPS + 4 }, (_, i) => `NOVA | Tarefa ${i} | motivo`).join('\n')
    expect(parsePoVerdict(many, ids)).toHaveLength(PO_MAX_OPS)
  })

  it('prosa pura vira silêncio, nunca uma operação inventada', () => {
    expect(parsePoVerdict('Acho que a tarefa 1 já está pronta, o agente deveria marcar.', ids)).toEqual([])
  })
})

describe('rejectUnsafeOps — a última barreira antes do banco', () => {
  it('CONCLUI o cartão que ficou em andamento — este é o caso central do recurso', () => {
    // O agente marca o início, faz o trabalho e esquece o fim: o cartão fica
    // exatamente nesse estado. Uma versão anterior barrava este caso — e, com
    // ele, o recurso inteiro, já que "pending → concluído" é o caso raro.
    const cards = [card({ sourceStatus: 'in_progress' })]
    expect(rejectUnsafeOps([{ kind: 'complete', id: 'bi-1', reason: 'arquivo escrito' }], cards)).toHaveLength(1)
  })

  it('não conclui tarefa que já está concluída', () => {
    const cards = [card({ sourceStatus: 'completed' })]
    expect(rejectUnsafeOps([{ kind: 'complete', id: 'bi-1', reason: 'x' }], cards)).toEqual([])
  })

  it('não reconcluir o que o próprio PO já concluiu', () => {
    const cards = [card({ poStatus: 'completed', poReason: 'antes' })]
    expect(rejectUnsafeOps([{ kind: 'complete', id: 'bi-1', reason: 'de novo' }], cards)).toEqual([])
  })

  it('conclui a tarefa pendente que de fato terminou', () => {
    const cards = [card()]
    expect(rejectUnsafeOps([{ kind: 'complete', id: 'bi-1', reason: 'arquivo escrito' }], cards)).toHaveLength(1)
  })

  it('título idêntico ao do agente não vira escrita à toa', () => {
    const cards = [card()]
    expect(rejectUnsafeOps([{ kind: 'retitle', id: 'bi-1', title: 'add board table' }], cards)).toEqual([])
  })

  it('cartão inexistente é barrado mesmo se passar pelo parser', () => {
    expect(rejectUnsafeOps([{ kind: 'retitle', id: 'sumiu', title: 'x' }], [card()])).toEqual([])
  })
})
