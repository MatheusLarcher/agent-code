// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BoardItem } from '../../shared/ipc'
import {
  buildPoDigest,
  buildPoPrompt,
  PO_AWAITING_AUTHORIZATION_REASON,
  PO_MAX_CALLS,
  PO_MAX_OPS,
  PO_MAX_REPLY_CHARS,
  PO_REPLY_HEAD_CHARS,
  PO_RESUMED_MARK,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN,
  summarizeCall
} from './poPrompt'
import { parsePoVerdict, rejectUnsafeOps } from './poVerdict'

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

describe('digest — última resposta do agente', () => {
  const base = { userText: 'pesquisa direito', cards: [], calls: [] }

  it('sem resposta, o digest é exatamente o de antes', () => {
    const without = buildPoDigest(base)
    expect(buildPoDigest({ ...base, agentReply: null })).toBe(without)
    expect(buildPoDigest({ ...base, agentReply: '   ' })).toBe(without)
    expect(without).not.toContain('ÚLTIMA RESPOSTA DO AGENTE')
  })

  it('mostra a resposta nas duas fases', () => {
    for (const phase of ['open', 'close'] as const) {
      const digest = buildPoDigest({ ...base, phase, agentReply: 'Encontrei três opções de cadastro.' })
      expect(digest).toContain('ÚLTIMA RESPOSTA DO AGENTE:\nEncontrei três opções de cadastro.')
    }
  })

  it('resposta longa leva as DUAS pontas — o que foi entregue e a pergunta do fim — dentro do teto', () => {
    const reply = `Entreguei a correção do login. ${'contexto '.repeat(200)}Posso aplicar a correção?`
    const digest = buildPoDigest({ ...base, agentReply: reply })
    const section = digest.split('ÚLTIMA RESPOSTA DO AGENTE:\n')[1]
    expect(section.length).toBe(PO_MAX_REPLY_CHARS)
    expect(section.startsWith('Entreguei a correção do login.')).toBe(true)
    expect(section.endsWith('Posso aplicar a correção?')).toBe(true)
    // O meio vira um "…" só, entre as pontas.
    expect(section.charAt(PO_REPLY_HEAD_CHARS)).toBe('…')
  })

  it('o fechamento aceita a resposta como evidência e proíbe concluir o que espera o usuário', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('ÚLTIMA RESPOSTA DO AGENTE entrega\n  o resultado pedido')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/pergunta BLOQUEIA o pedido[\s\S]*NÃO use CONCLUIR[\s\S]*use PENDENTE/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Suposição não basta para um cartão que o turno nem tocou')
  })

  it('o fechamento conclui por padrão: só o PENDENTE (o agente disse que não terminou) segura o cartão', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(`Cada cartão da seção\n  "${PO_RETURNED_SECTION}" vira CONCLUÍDO sozinho`)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('PENDENTE é o ÚNICO jeito de um cartão continuar "a fazer" num turno normal')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Na dúvida entre concluído e não terminado, é CONCLUÍDO')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Pergunta no fim da resposta NÃO é sinal de trabalho incompleto.')
    // O padrão antigo ("na dúvida, OK", "sem prova é o tipo a") saiu do fechamento.
    expect(PO_SYSTEM_PROMPT_CLOSE).not.toContain('Na dúvida, responda OK')
    expect(PO_SYSTEM_PROMPT_CLOSE).not.toContain('Sem prova da entrega')
    expect(PO_SYSTEM_PROMPT_CLOSE).not.toContain('é o pior erro')
    // O retomado pela mensagem do usuário que o turno não tocou não conclui.
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(`Um cartão marcado ${PO_RESUMED_MARK} só entrou em andamento`)
    // A abertura continua com o "na dúvida, OK": ali OK não conclui nada.
    expect(PO_SYSTEM_PROMPT_OPEN).toContain('Na dúvida, responda OK.')
  })

  it('a abertura usa a resposta anterior para continuação e títulos com contexto', () => {
    expect(PO_SYSTEM_PROMPT_OPEN).toContain('"ÚLTIMA RESPOSTA DO AGENTE"')
    expect(PO_SYSTEM_PROMPT_OPEN).toContain('só vira cartão o que o USUÁRIO pediu')
  })
})

/**
 * Os dois casos reais da conversa "Cadastro no sistema": a regra antiga ("a
 * resposta termina com pergunta → não conclui") tratava os dois igual, e o
 * cartão da auditoria foi e voltou entre "em andamento" e "a fazer" 9 vezes.
 */
describe('pergunta no fim da resposta — bloqueia o pedido ou propõe um passo novo', () => {
  const AUDIT_ID = 'bi-po-e13d96f9-e46'
  const PEDIDO_1 =
    'olha as conversas, hermes.larchertech.com eu desativei nao é pra registrar nada no meu cloud flare e e nenhuma conta minha sem eu pedi'
  const RESPOSTA_1 = [
    '**Cloudflare:** me desculpe por ter mexido sem você pedir. Na última tentativa só abri a janela',
    '"Adicionar registro" e não salvei nada; o `hermes` continua desativado.',
    '**O que já fiz, só no seu PC:** - O programa passou a validar a licença em `alcaios.larchertech.com`.',
    'Os 7 testes do login pelo site passaram. - Gerei o `.exe` novo.',
    '**Falta, na VPS, e só faço se você autorizar:** 1. Trocar `APP_BASE_URL` e reiniciar o servidor.',
    '2. Enviar o `.exe` novo para o download do painel.',
    '- O Mercado Pago ainda deve estar mandando os avisos de pagamento para o `hermes`, e sem isso as',
    'compras novas não liberam a licença sozinhas. Isso se troca na sua conta do Mercado Pago, e eu não',
    'vou mexer lá. Posso atualizar a VPS?'
  ].join(' ')
  const RESPOSTA_2 =
    '"Entrar pelo site" fica só como plano B, para quando alguém renomear o arquivo. Isso é só código e build. ' +
    'Mas, para o cliente conseguir baixar o setup, preciso trocar o arquivo na VPS. Também precisa ajustar o ' +
    '`APP_BASE_URL`, que ficou pendente do problema do `hermes`. Faço o setup assim? E, quando estiver pronto ' +
    'e testado, autoriza atualizar a VPS?'
  const cards = [
    card({
      id: AUDIT_ID,
      origin: 'po',
      sourceTitle: 'Auditar/remover qualquer registro em Cloudflare ou conta própria feito sem autorização',
      sourceStatus: 'in_progress'
    }),
    card({ id: 'bi-po-fae60b12-250', origin: 'po', sourceTitle: 'Concluir renomeação para ALCAIOS (site, exe, VPS)' })
  ]
  const ids = cards.map((c) => c.id)

  it('o fechamento distingue os tipos pela declaração de não-término, com os exemplos reais', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('A pergunta BLOQUEIA o pedido')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('A pergunta PROPÕE UM PASSO NOVO depois de o pedido ter sido entregue')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('a resposta diz que o pedido do usuário NÃO foi entregue?')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Na dúvida entre a) e b), é b): o pedido foi entregue.')
    // Tipo c): entregue no essencial com pendências → CONCLUIR o pedido + uma NOVA por pendência,
    // em vez de deixar o cartão inteiro "a fazer" (caso real: fase 1 do escritório).
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('O pedido foi ENTREGUE no essencial')
    // Aprovar é o normal: "falta testar em cenário real" não reprova o pedido feito —
    // conclui e abre um cartão "Testar <o que> em <cenário X>".
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('REPROVAR É A EXCEÇÃO, APROVAR É O NORMAL')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/falta testar em cenário real[\s\S]*NÃO é motivo para PENDENTE/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('"Testar <o que> em <cenário X>"')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(
      `NOVA <id do cartão do desconto> | Testar o desconto numa nota de filial | ${PO_AWAITING_AUTHORIZATION_REASON}`
    )
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('uma NOVA <id do cartão do\n     pedido> para CADA pendência')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(
      `NOVA <id do cartão da fase 1> | Commitar a fase 1 do escritório | ${PO_AWAITING_AUTHORIZATION_REASON}`
    )
    // Exemplo b): entregue + "Posso atualizar a VPS?" → CONCLUIR + NOVA a fazer.
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Posso atualizar a VPS?')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(
      `NOVA <id do cartão da auditoria> | Atualizar a VPS (APP_BASE_URL e .exe novo) | ${PO_AWAITING_AUTHORIZATION_REASON}`
    )
    // A pendência cita o cartão de origem e diz QUAL tarefa.
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('NOVA <id do cartão de origem> | <título> | <motivo curto>')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('"Commitar a fase 1 do\nescritório", nunca só "Commitar"')
    // Exemplo a): "Faço o setup assim?" antes de fazer → nada de CONCLUIR, e sim PENDENTE.
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Faço o setup assim?')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('nada de CONCLUIR no trabalho do setup')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('PENDENTE <id do cartão do setup> | esperando o usuário aprovar')
  })

  it('a NOVA do fechamento aceita o passo proposto pelo agente, nunca uma sugestão do próprio PO', () => {
    expect(PO_AWAITING_AUTHORIZATION_REASON).toBe('aguardando autorização do usuário')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/NOVA é o contrário:[\s\S]*passo novo que o AGENTE propôs[\s\S]*nasce "a fazer"/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('nem para sugerir uma tarefa que VOCÊ acha que')
    // O passo que já tem cartão "a fazer" não ganha outro (probe: o quadro real tinha um).
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('Se um cartão "a fazer" do quadro já cobre esse passo,\n     não crie outro')
  })

  it('a abertura manda a autorização para o cartão "a fazer" do passo, nunca para o concluído', () => {
    expect(PO_SYSTEM_PROMPT_OPEN).toMatch(/propôs um PASSO NOVO[\s\S]*"pode fazer", "sim", "faça isso"[\s\S]*ANDAMENTO no cartão "a fazer"/)
    expect(PO_SYSTEM_PROMPT_OPEN).toContain(`"${PO_AWAITING_AUTHORIZATION_REASON}"`)
    expect(PO_SYSTEM_PROMPT_OPEN).toContain('Nunca use ANDAMENTO no cartão já concluído do pedido')
  })

  it('o prompt do fechamento do caso 1 leva a pergunta do fim da resposta real', () => {
    const prompt = buildPoPrompt({
      phase: 'close',
      userText: PEDIDO_1,
      cards: cards.map((c) => ({ id: c.id, title: c.sourceTitle, status: c.sourceStatus })),
      calls: [{ tool: 'Bash', detail: 'npx vitest run' }, { tool: 'Bash', detail: 'npm run build:win' }],
      agentReply: RESPOSTA_1
    })
    expect(prompt).toContain(`${AUDIT_ID} [em andamento] Auditar/remover`)
    expect(prompt).toMatch(/ÚLTIMA RESPOSTA DO AGENTE:\n.*e eu não vou mexer lá\. Posso atualizar a VPS\?$/)
  })

  it('caso 1: CONCLUIR no pedido + NOVA do passo viram [complete, create "a fazer" aguardando autorização]', () => {
    const verdict = [
      `CONCLUIR ${AUDIT_ID} | auditoria entregue: nada registrado sem autorização`,
      `NOVA | Atualizar a VPS (APP_BASE_URL e .exe novo) | ${PO_AWAITING_AUTHORIZATION_REASON}`
    ].join('\n')
    expect(rejectUnsafeOps(parsePoVerdict(verdict, ids, 'close'), cards, 'close')).toEqual([
      { kind: 'complete', id: AUDIT_ID, reason: 'auditoria entregue: nada registrado sem autorização' },
      {
        kind: 'create',
        title: 'Atualizar a VPS (APP_BASE_URL e .exe novo)',
        reason: 'aguardando autorização do usuário',
        status: 'pending'
      }
    ])
  })

  it('caso 2: a pergunta bloqueia o pedido (setup não feito) — o prompt leva a pergunta e OK não escreve nada', () => {
    const prompt = buildPoPrompt({
      phase: 'close',
      userText: 'quero q seja setup eu ja tinha falado isso, pq nao fez? verifique o motivo',
      cards: cards.map((c) => ({ id: c.id, title: c.sourceTitle, status: c.sourceStatus })),
      calls: [{ tool: 'Read', detail: 'desktop/electron-builder.yml' }],
      agentReply: RESPOSTA_2
    })
    expect(prompt).toContain('Faço o setup assim? E, quando estiver pronto e testado, autoriza atualizar a VPS?')
    expect(rejectUnsafeOps(parsePoVerdict('OK', ids, 'close'), cards, 'close')).toEqual([])
  })

  it('na abertura seguinte, ANDAMENTO no concluído é barrado e o do passo "a fazer" passa', () => {
    const after = [
      card({ ...cards[0], poStatus: 'completed', poReason: 'auditoria entregue' }),
      card({ id: 'bi-po-vps', origin: 'po', sourceTitle: 'Atualizar a VPS', poReason: PO_AWAITING_AUTHORIZATION_REASON })
    ]
    const verdict = `ANDAMENTO bi-po-vps | o usuário autorizou\nANDAMENTO ${AUDIT_ID} | retomando`
    expect(rejectUnsafeOps(parsePoVerdict(verdict, after.map((c) => c.id), 'open'), after, 'open')).toEqual([
      { kind: 'start', id: 'bi-po-vps', reason: 'o usuário autorizou' }
    ])
  })
})

describe('digest', () => {
  it('leva pedido, quadro e as ÚLTIMAS ações — e respeita os tetos', () => {
    const digest = buildPoDigest({
      userText: 'faz o quadro',
      cards: [{ id: 'bi-1', title: 'uma', status: 'pending' }],
      calls: Array.from({ length: PO_MAX_CALLS + 5 }, (_, i) => ({ tool: 'Edit', detail: `arquivo${i}.ts` }))
    })
    expect(digest).toContain('faz o quadro')
    expect(digest).toContain('bi-1 [a fazer] uma')
    // As 5 primeiras saem; da 6ª até a última, todas ficam.
    expect(digest).not.toContain('- Edit: arquivo4.ts\n')
    expect(digest).toContain('- Edit: arquivo5.ts\n')
    expect(digest).toContain(`- Edit: arquivo${PO_MAX_CALLS + 4}.ts`)
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
    // A regra que reconhece continuação de um cartão já existente — sem ela o
    // PO responde OK para "continua"/"pode" só porque a mensagem, isolada, não
    // parece um pedido novo, e o cartão fica preso em "a fazer".
    expect(open).toContain('CONTINUAÇÃO')

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
        'TITULO bi-2 | Criar a tabela do quadro | o título do agente era técnico demais',
        'NOVA | Documentar o PO | o agente disse que falta',
        'FEITA | Arrumar o login | o arquivo foi escrito neste turno'
      ].join('\n'),
      ids,
      'close'
    )
    expect(ops).toEqual([
      { kind: 'complete', id: 'bi-1', reason: 'o arquivo foi escrito e o teste passou' },
      { kind: 'retitle', id: 'bi-2', title: 'Criar a tabela do quadro', reason: 'o título do agente era técnico demais' },
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
    expect(rejectUnsafeOps([{ kind: 'retitle', id: 'bi-1', title: 'add board table', reason: 'legível' }], cards)).toEqual([])
  })

  it('cartão inexistente é barrado mesmo se passar pelo parser', () => {
    expect(rejectUnsafeOps([{ kind: 'retitle', id: 'sumiu', title: 'x', reason: 'y' }], [card()])).toEqual([])
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

  describe('create duplicado na ABERTURA vira ANDAMENTO — a intenção não pode se perder', () => {
    it('cartão colidido pending: o create duplicado converte em start', () => {
      const cards = [card({ sourceStatus: 'pending' })]
      const create = { kind: 'create' as const, title: 'add board table', reason: 'o pedido é este', status: 'in_progress' as const }
      const ops = rejectUnsafeOps([create], cards, 'open')
      // O motivo do create original sobrevive na conversão — é ele que explica
      // por que o cartão pulou para "em andamento".
      expect(ops).toEqual([{ kind: 'start', id: 'bi-1', reason: 'o pedido é este' }])
    })

    it('na fase CLOSE não existe ANDAMENTO: o create duplicado continua só descartado', () => {
      const cards = [card({ sourceStatus: 'pending' })]
      const create = { kind: 'create' as const, title: 'add board table', reason: 'x', status: 'pending' as const }
      expect(rejectUnsafeOps([create], cards, 'close')).toEqual([])
      // Sem fase informada o comportamento é o de fechamento (mesmo default de parsePoVerdict).
      expect(rejectUnsafeOps([create], cards)).toEqual([])
    })

    it('cartão colidido já em andamento ou concluído: sem conversão, create continua descartado', () => {
      const create = { kind: 'create' as const, title: 'add board table', reason: 'x', status: 'in_progress' as const }
      expect(rejectUnsafeOps([create], [card({ sourceStatus: 'in_progress' })], 'open')).toEqual([])
      expect(rejectUnsafeOps([create], [card({ sourceStatus: 'completed' })], 'open')).toEqual([])
      expect(rejectUnsafeOps([create], [card({ poStatus: 'completed', poReason: 'antes' })], 'open')).toEqual([])
    })

    it('não duplica quando o modelo já emitiu seu próprio start pro mesmo id', () => {
      const cards = [card({ sourceStatus: 'pending' })]
      const ops = rejectUnsafeOps(
        [
          { kind: 'start', id: 'bi-1', reason: 'o modelo já viu o cartão' },
          { kind: 'create', title: 'add board table', reason: 'duplicado', status: 'in_progress' }
        ],
        cards,
        'open'
      )
      // Só o start explícito do modelo sobrevive — a conversão do create não
      // aplica `applyPo` duas vezes no mesmo cartão.
      expect(ops).toEqual([{ kind: 'start', id: 'bi-1', reason: 'o modelo já viu o cartão' }])
    })
  })
})
