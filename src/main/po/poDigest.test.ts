// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardItemStatus } from '../../shared/ipc'
import type { TaskRepository } from '../persistence/types'
import { configureTaskRuntime } from '../tasks/taskRuntime'
import { listConvTasks } from './poLedger'
import {
  buildPoDigest,
  pickLedgerTasks,
  PO_MAX_CALLS,
  PO_MAX_DIGEST_CHARS,
  PO_MAX_LEDGER_TASKS,
  PO_MAX_REPLY_CHARS,
  PO_REPLY_HEAD_CHARS,
  PO_REPLY_TAIL_CHARS,
  type PoCall,
  type PoLedgerTask
} from './poPrompt'

/**
 * O fechamento das 14:54 (UTC) de 2026-09-29 na conversa "Cadastro no sistema":
 * turno de ~90 ações, e o PO concluiu o cartão do login Google em vez do cartão
 * do EXE com o e-mail embutido — o que o pedido era. A prova de que o EXE foi
 * testado estava no INÍCIO da resposta, que o digest cortava; o fim só dizia o
 * que ficou para trás.
 */
const PEDIDO =
  'preciso q vc corrija e teste pra ve se ainda tem erro, só fale q ta pronto depos de vc testar todo o fluxo. ' +
  'lembrando q o emai ltem q ta embutido no exe setup q é baixado pelo site, assim q logar, tem q gerar o exe ' +
  'caso nao tenha. se atualziar o app tem q gerar novamente com o email embitido pra cada usuariio'

const EXE_CARD = 'bi-po-fca88801-fc7'
const GOOGLE_CARD = 'bi-po-f89af725-ca6'

/** O quadro daquele fechamento, com os títulos como o digest real os levou. */
const QUADRO: { id: string; title: string; status: BoardItemStatus }[] = [
  [EXE_CARD, 'in_progress', 'Corrigir e testar geração automática do EXE com email do usuário embutido (gerar no login…'],
  ['bi-po-e13d96f9-e46', 'in_progress', 'Auditar/remover qualquer registro em Cloudflare ou conta própria feito sem autorização ap…'],
  [GOOGLE_CARD, 'in_progress', 'Adicionar login com Google, remover senha do EXE (usar apenas email para cadastro) e exib…'],
  ['bi-po-57479a08-3cd', 'pending', 'Remover atualização vitalícia do site'],
  ['bi-po-fae60b12-250', 'pending', 'Concluir renomeação para ALCAIOS (site, exe, VPS) e publicar novamente'],
  ['bi-po-c745dc97-dd7', 'pending', 'Gerar logo para o nome ALCAIOS (aguardando escolha entre 3 conceitos)'],
  ['bi-po-aa6ffb7c-534', 'completed', 'Compilar exe embutido sem exigir senha do usuário, com fluxo simples'],
  ['bi-po-3bede24f-ca5', 'completed', 'Subir aplicação na VPS com domínio hermes.larchertech.com (Cloudflare configurado)']
].map(([id, status, title]) => ({ id, title, status: status as BoardItemStatus }))

/** RECONSTRUÍDO: o log só guardou o fim da resposta. É o tipo de abertura que
 *  o agente escreve — a entrega primeiro —, e é o trecho que o corte antigo perdia. */
const INICIO_RECONSTRUIDO =
  'Pronto: testei o fluxo inteiro da geração do setup com o e-mail embutido — login, geração automática, ' +
  'download pelo site e instalação. O erro era o setup não ser gerado no primeiro login; agora, assim que a ' +
  'pessoa entra no site, o servidor gera o setup dela com o e-mail embutido se ainda não existir, e a cada ' +
  'atualização do app gera de novo para cada usuário.'

/** RECONSTRUÍDO: o relato do meio, que é o que o corte pode perder sem dano. */
const MEIO_RECONSTRUIDO =
  '**Como testei:** 1. Criei duas contas novas pelo site e entrei com cada uma; o painel mostrou o botão de ' +
  'download em poucos segundos. 2. Baixei os dois instaladores e conferi o hash do instalador contra o gerado ' +
  'no servidor: cada um tem o e-mail da própria conta. 3. Instalei e abri o app neste PC: ele entrou sozinho, ' +
  'sem pedir senha, e a tela de "Sem conexão" não apareceu mais. 4. Publiquei uma versão nova e os dois setups ' +
  'foram gerados de novo, cada um com o seu e-mail. **Mercado Pago:** vale conferir no painel do Mercad'

/** REAL: o fim que o digest das 14:54 levou (os últimos 599 caracteres). */
const FIM_REAL =
  'o Pago se não há um webhook fixo apontando para o `hermes`; eu não mexi lá. **O que ficou para trás:** - ' +
  '**No servidor:** duas contas de teste (`teste-e2e-…@larchertech.com`) com seus instaladores, cerca de 110 MB ' +
  'cada. Se quiser, apago. - **No seu Chrome:** ficou aberta uma aba do painel, do teste do botão. - **Neste ' +
  'PC:** o Alcaios de teste foi desinstalado e as pastas temporárias e a entrada de início automático criadas ' +
  'pelo teste foram removidas. Seus dados e seu início automático não foram mexidos. Não mexi no Cloudflare, no ' +
  'Google nem no Mercado Pago. O código está no GitHub, no `main`.'

const RESPOSTA = `${INICIO_RECONSTRUIDO} ${MEIO_RECONSTRUIDO}${FIM_REAL}`

/** 93 ações: as 33 primeiras (leituras do começo) têm de sair; as 60 últimas,
 *  com o teste e a publicação do fim, têm de ficar. */
const ACOES: PoCall[] = [
  ...Array.from({ length: 33 }, (_, i) => ({ tool: 'Read', detail: `server/src/setup/antigo-${i}.ts` })),
  ...Array.from({ length: 57 }, (_, i) => ({ tool: 'Bash', detail: `node scripts/e2e-setup.mjs --passo ${i}` })),
  { tool: 'Bash', detail: 'npx vitest run server/src/setup' },
  { tool: 'Bash', detail: 'curl -sI https://alcaios.larchertech.com/download/setup.exe' },
  { tool: 'Bash', detail: 'git push origin main' }
]

/** O registro em ordem cronológica. As 6 do fim são as REAIS daquele digest; as
 *  de antes são RECONSTRUÍDAS a partir dos cartões concluídos do quadro, para a
 *  conversa passar de PO_MAX_LEDGER_TASKS como uma conversa longa passa. */
const REGISTRO: PoLedgerTask[] = [
  ...[
    'Subir aplicação na VPS com domínio hermes',
    'Descobrir o subdomínio da larchertech',
    'Gerar prompt e vídeo comercial',
    'Levantar skills de landing page',
    'Subir landing page em produção',
    'Senha no painel: criar e alterar',
    'Compilar exe embutido sem senha',
    'Testar pagamento do Castro',
    'Testar mudança recente e dar commit',
    'Pensar em outro nome para a aplicação',
    'Trocar o texto pedido no navegador'
  ].map((title) => ({ title, status: 'done' })),
  { title: 'Publicar setup na VPS (1ª tentativa)', status: 'failed' },
  { title: 'Gerar setup sem e-mail', status: 'cancelled' },
  { title: 'Pesquisar nome para aplicativo fiscal antes de sugerir', status: 'done' },
  { title: 'Buscar nome impactante com triagem prévia', status: 'done' },
  { title: 'Conceitos de logo ALCAIOS', status: 'pending' },
  { title: 'Servidor: login Google + liberação do app pelo site', status: 'done' },
  { title: "App: 'Entrar pelo site' sem senha + modal de bloqueio", status: 'done' },
  { title: "Setup por conta com e-mail embutido + corrigir 'Sem conexão'", status: 'pending' },
  { title: 'Enviar o setup por e-mail', status: 'failed' }
]

function section(digest: string, label: string): string {
  return digest.split(`${label}\n`)[1]?.split('\n\n')[0] ?? ''
}

describe('digest do fechamento — o caso das 14:54 (turno longo)', () => {
  const digest = buildPoDigest({
    phase: 'close',
    userText: PEDIDO,
    cards: QUADRO,
    calls: ACOES,
    agentReply: RESPOSTA,
    ledgerTasks: REGISTRO
  })

  it('o material do teste é o de um turno longo de verdade', () => {
    expect(ACOES.length).toBeGreaterThan(PO_MAX_CALLS)
    expect(RESPOSTA.length).toBeGreaterThan(PO_MAX_REPLY_CHARS)
    expect(REGISTRO.length).toBeGreaterThan(PO_MAX_LEDGER_TASKS)
    // As duas pontas cabem inteiras nos seus tetos.
    expect(INICIO_RECONSTRUIDO.length).toBeLessThanOrEqual(PO_REPLY_HEAD_CHARS)
    expect(FIM_REAL.length).toBeLessThanOrEqual(PO_REPLY_TAIL_CHARS)
    // E a consulta antiga (`limit` sobre a ordem crescente = as 15 MAIS
    // ANTIGAS) deixava de fora justamente as tarefas do trabalho de agora.
    const antigo = REGISTRO.slice(0, PO_MAX_LEDGER_TASKS).map((task) => task.title)
    expect(antigo).not.toContain('Servidor: login Google + liberação do app pelo site')
    expect(antigo).not.toContain("Setup por conta com e-mail embutido + corrigir 'Sem conexão'")
  })

  it('leva o INÍCIO (a prova de que o EXE foi testado) e o FIM real da resposta', () => {
    const reply = section(digest, 'ÚLTIMA RESPOSTA DO AGENTE:')
    expect(reply.length).toBe(PO_MAX_REPLY_CHARS)
    expect(reply.startsWith(INICIO_RECONSTRUIDO)).toBe(true)
    expect(reply.endsWith(FIM_REAL)).toBe(true)
    // O que sai é o meio.
    expect(reply).not.toContain('conferi o hash do instalador')
  })

  it('leva as ÚLTIMAS ações, não as primeiras', () => {
    const calls = section(digest, 'AÇÕES DESTE TURNO:').split('\n')
    expect(calls).toHaveLength(PO_MAX_CALLS)
    expect(calls.some((line) => line.includes('antigo-'))).toBe(false)
    expect(calls[0]).toBe('- Bash: node scripts/e2e-setup.mjs --passo 0')
    expect(calls.slice(-3)).toEqual([
      '- Bash: npx vitest run server/src/setup',
      '- Bash: curl -sI https://alcaios.larchertech.com/download/setup.exe',
      '- Bash: git push origin main'
    ])
  })

  it('leva as tarefas [done] e abertas mais recentes do registro, em ordem cronológica', () => {
    const tasks = section(digest, 'TAREFAS DO REGISTRO NESTA CONVERSA:').split('\n')
    expect(tasks).toHaveLength(PO_MAX_LEDGER_TASKS)
    expect(tasks.slice(-4)).toEqual([
      '- Conceitos de logo ALCAIOS [pending]',
      '- Servidor: login Google + liberação do app pelo site [done]',
      "- App: 'Entrar pelo site' sem senha + modal de bloqueio [done]",
      "- Setup por conta com e-mail embutido + corrigir 'Sem conexão' [pending]"
    ])
    // Falha e cancelamento só entram com vaga sobrando — aqui não sobra.
    expect(digest).not.toContain('[failed]')
    expect(digest).not.toContain('[cancelled]')
    // As duas mais antigas são as que saem.
    expect(digest).not.toContain('Subir aplicação na VPS com domínio hermes [done]')
    expect(digest).not.toContain('Descobrir o subdomínio da larchertech [done]')
    expect(digest).toContain('Gerar prompt e vídeo comercial [done]')
  })

  it('o quadro e o pedido vão inteiros, e o digest fica dentro do teto total', () => {
    expect(digest).toContain(`${EXE_CARD} [em andamento] Corrigir e testar geração automática do EXE`)
    expect(digest).toContain(`${GOOGLE_CARD} [em andamento] Adicionar login com Google`)
    expect(digest).toContain(PEDIDO)
    expect(digest.length).toBeLessThanOrEqual(PO_MAX_DIGEST_CHARS)
  })

  it('a abertura leva o mesmo corte de duas pontas — o fim fica igual', () => {
    const open = buildPoDigest({ phase: 'open', userText: 'pode apagar', cards: QUADRO, calls: [], agentReply: RESPOSTA })
    expect(section(open, 'ÚLTIMA RESPOSTA DO AGENTE:')).toBe(section(digest, 'ÚLTIMA RESPOSTA DO AGENTE:'))
  })
})

describe('digest — teto total', () => {
  it('o pior caso, com TODOS os tetos estourados, fecha exatamente na conta documentada', () => {
    const digest = buildPoDigest({
      phase: 'close',
      userText: 'p'.repeat(5_000),
      // Id acima do formato do quadro: o corte da linha come o título, não o id.
      cards: Array.from({ length: 40 }, (_, i) => ({
        id: `bi-${String(i).padStart(40, '0')}`,
        title: 't'.repeat(300),
        status: 'in_progress' as const
      })),
      calls: Array.from({ length: 100 }, () => ({ tool: 'mcp__servidor__ferramenta', detail: 'd'.repeat(500) })),
      agentReply: 'r'.repeat(5_000),
      ledgerTasks: Array.from({ length: 30 }, () => ({ title: 'x'.repeat(300), status: 's'.repeat(40) })),
      background: Array.from({ length: 12 }, () => 'b'.repeat(400))
    })
    expect(digest.length).toBe(PO_MAX_DIGEST_CHARS)
    expect(PO_MAX_DIGEST_CHARS).toBe(21_032)
    expect(digest).toContain(`bi-${'0'.repeat(40)} [em andamento] ttt`)
  })

  it('uma linha de ação enorme é cortada no teto da linha, não estoura o digest', () => {
    const digest = buildPoDigest({
      userText: 'x',
      cards: [],
      calls: [{ tool: 'Grep', detail: `${'a'.repeat(1_000)}\n\nFIM` }]
    })
    const line = section(digest, 'AÇÕES DESTE TURNO:')
    expect(line.startsWith('- Grep: aaa')).toBe(true)
    expect(line.length).toBe(2 + 200)
    expect(line).not.toContain('FIM')
  })
})

describe('pickLedgerTasks — quais tarefas do registro cabem no digest', () => {
  const task = (title: string, status: string): PoLedgerTask => ({ title, status })

  it('dentro do teto, a lista sai igual — inclusive failed/cancelled e a ordem', () => {
    const tasks = [task('a', 'failed'), task('b', 'done'), task('c', 'cancelled')]
    expect(pickLedgerTasks(tasks)).toEqual(tasks)
  })

  it('acima do teto: done/abertas mais recentes primeiro; failed/cancelled só com vaga sobrando', () => {
    const tasks = [
      task('falha-antiga', 'failed'),
      ...Array.from({ length: 14 }, (_, i) => task(`feita-${i}`, i % 2 === 0 ? 'done' : 'running')),
      task('cancelada-recente', 'cancelled'),
      task('falha-recente', 'failed')
    ]
    const picked = pickLedgerTasks(tasks).map((t) => t.title)
    expect(picked).toHaveLength(PO_MAX_LEDGER_TASKS)
    // As 14 do grupo de cima entram todas; a 15ª vaga vai para a failed/cancelled MAIS recente.
    expect(picked.slice(0, 14)).toEqual(Array.from({ length: 14 }, (_, i) => `feita-${i}`))
    expect(picked[14]).toBe('falha-recente')
  })

  it('é idempotente: aplicar de novo não muda a escolha', () => {
    const once = pickLedgerTasks(REGISTRO)
    expect(pickLedgerTasks(once)).toEqual(once)
  })
})

describe('listConvTasks — o registro inteiro, escolhido antes de chegar ao PO e ao gate', () => {
  afterEach(() => configureTaskRuntime(null))

  it('lê a conversa SEM limit (a ordem do registro é crescente) e devolve a escolha', async () => {
    const listTasks = vi.fn(async () => REGISTRO.map((t, i) => ({ ...t, id: `t-${i}`, createdAt: `2026-09-29T10:${String(i).padStart(2, '0')}:00.000Z` })))
    configureTaskRuntime({ listTasks } as unknown as TaskRepository)
    const tasks = await listConvTasks({}, 'conv-1')
    expect(listTasks).toHaveBeenCalledWith({ conversationId: 'conv-1' })
    expect(tasks).toEqual(pickLedgerTasks(REGISTRO))
    expect(tasks).toContainEqual({ title: 'Servidor: login Google + liberação do app pelo site', status: 'done' })
  })

  it('a origem injetada passa pela mesma escolha — o gate recebe o que o digest mostra', async () => {
    const tasks = await listConvTasks({ listConvTasks: async () => REGISTRO }, 'conv-1')
    expect(tasks).toEqual(pickLedgerTasks(REGISTRO))
    expect(tasks).toHaveLength(PO_MAX_LEDGER_TASKS)
  })
})
