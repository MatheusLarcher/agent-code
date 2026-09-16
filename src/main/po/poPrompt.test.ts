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

  it('a abertura não leva seção de ações — o turno ainda nem começou', () => {
    const open = buildPoDigest({ userText: 'arruma o login', cards: [], calls: [], phase: 'open' })
    expect(open).toContain('PEDIDO DO USUÁRIO')
    expect(open).toContain('QUADRO ATUAL')
    expect(open).not.toContain('AÇÕES DESTE TURNO')
  })

  it('cada fase carrega as SUAS operações, e só elas', () => {
    const open = buildPoPrompt({ userText: 'x', cards: [], calls: [], phase: 'open' })
    expect(open).toContain('ANDAMENTO <id>')
    expect(open).toContain('NOVA | <título>')
    expect(open).not.toContain('CONCLUIR <id>')
    // A regra que impede o quadro de virar registro de conversa.
    expect(open).toContain('NÃO viram cartão')

    const close = buildPoPrompt({ userText: 'x', cards: [], calls: [], phase: 'close' })
    expect(close).toContain('CONCLUIR <id>')
    expect(close).toContain('FEITA | <título>')
    expect(close).not.toContain('ANDAMENTO <id>')
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

  it('lê as operações do fechamento', () => {
    const ops = parsePoVerdict(
      [
        'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou',
        'TITULO bi-2 | Criar a tabela do quadro',
        'NOVA | Documentar o PO | o agente disse que falta',
        'FEITA | Arrumar o login | o arquivo foi escrito neste turno'
      ].join('\n'),
      ids,
      'close'
    )
    expect(ops).toEqual([
      { kind: 'complete', id: 'bi-1', reason: 'o arquivo foi escrito e o teste passou' },
      { kind: 'retitle', id: 'bi-2', title: 'Criar a tabela do quadro' },
      { kind: 'create', title: 'Documentar o PO', reason: 'o agente disse que falta', status: 'pending' },
      // FEITA nasce CONCLUÍDA: é o trabalho que já aconteceu e não tinha cartão.
      { kind: 'create', title: 'Arrumar o login', reason: 'o arquivo foi escrito neste turno', status: 'completed' }
    ])
  })

  it('lê as operações da abertura — cartão novo já nasce em andamento', () => {
    const ops = parsePoVerdict(
      ['NOVA | Arrumar o login | o usuário pediu agora', 'ANDAMENTO bi-1 | o pedido é este cartão'].join('\n'),
      ids,
      'open'
    )
    expect(ops).toEqual([
      { kind: 'create', title: 'Arrumar o login', reason: 'o usuário pediu agora', status: 'in_progress' },
      { kind: 'start', id: 'bi-1', reason: 'o pedido é este cartão' }
    ])
  })

  it('operação da fase errada é DESCARTADA — o modelo respondeu outra pergunta', () => {
    // Concluir na abertura falaria de um trabalho que ainda nem começou.
    expect(parsePoVerdict('CONCLUIR bi-1 | terminou', ids, 'open')).toEqual([])
    expect(parsePoVerdict('TITULO bi-1 | Outro título', ids, 'open')).toEqual([])
    expect(parsePoVerdict('FEITA | Já foi | aconteceu', ids, 'open')).toEqual([])
    // E reabrir no fechamento desfaria o que o turno acabou de terminar.
    expect(parsePoVerdict('ANDAMENTO bi-1 | começando', ids, 'close')).toEqual([])
  })

  it('sem fase informada continua sendo o PO de fechamento', () => {
    expect(parsePoVerdict('CONCLUIR bi-1 | terminou', ids)).toHaveLength(1)
    expect(parsePoVerdict('ANDAMENTO bi-1 | começando', ids)).toEqual([])
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

  it('põe em andamento só o cartão que ainda não começou', () => {
    const start = { kind: 'start' as const, id: 'bi-1', reason: 'é este o pedido' }
    expect(rejectUnsafeOps([start], [card()])).toHaveLength(1)
    // Já está em andamento: marcar de novo é escrita à toa.
    expect(rejectUnsafeOps([start], [card({ sourceStatus: 'in_progress' })])).toEqual([])
    // E reabrir o concluído seria o PO desfazendo um fato do agente.
    expect(rejectUnsafeOps([start], [card({ sourceStatus: 'completed' })])).toEqual([])
    expect(rejectUnsafeOps([start], [card({ poStatus: 'completed', poReason: 'antes' })])).toEqual([])
  })

  it('não recria cartão que já existe — acento e caixa não fazem título novo', () => {
    const create = (title: string) => [{ kind: 'create' as const, title, reason: 'x', status: 'in_progress' as const }]
    const cards = [card({ sourceTitle: 'Corrigir a exportação de XML' })]
    expect(rejectUnsafeOps(create('corrigir a exportacao de xml'), cards)).toEqual([])
    expect(rejectUnsafeOps(create('CORRIGIR   A   EXPORTAÇÃO DE XML'), cards)).toEqual([])
    // Trabalho de verdade diferente continua entrando.
    expect(rejectUnsafeOps(create('Corrigir a importação de XML'), cards)).toHaveLength(1)
  })

  it('o título comparado é o das DUAS camadas — inclusive o que o PO renomeou', () => {
    const cards = [card({ sourceTitle: 'add xml export', poTitle: 'Corrigir a exportação de XML' })]
    expect(rejectUnsafeOps(
      [{ kind: 'create', title: 'corrigir a exportacao de xml', reason: 'x', status: 'completed' }],
      cards
    )).toEqual([])
  })

  it('dois cartões equivalentes na mesma resposta viram um', () => {
    const ops = rejectUnsafeOps(
      [
        { kind: 'create', title: 'Documentar o quadro', reason: 'a', status: 'pending' },
        { kind: 'create', title: 'documentar o QUADRO', reason: 'b', status: 'pending' }
      ],
      [card()]
    )
    expect(ops).toHaveLength(1)
  })
})
