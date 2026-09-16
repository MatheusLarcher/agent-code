/**
 * Prova de campo do PO: roda o prompt REAL contra o modelo real, em casos
 * opostos, e imprime as operações já passadas pelo parser e pelas barreiras.
 *
 * Existe pelo mesmo motivo do `vigia-probe.ts`: o teste unitário prova o
 * parser, não a qualidade do prompt — e aqui a qualidade do prompt decide se o
 * quadro fica honesto ou se enche de conclusão errada. Os dois casos que mais
 * importam são os opostos de cada rodada: no FECHAMENTO o PO não pode concluir
 * o que não terminou, e na ABERTURA ele não pode deixar o pedido sem cartão.
 *
 * As DUAS rodadas são exercitadas porque são prompts diferentes — a abertura
 * pergunta "o que vai começar?" e o fechamento "o que terminou?". Provar uma só
 * deixaria a outra sem prova nenhuma da qualidade do texto.
 *
 * Bundlar com esbuild e rodar:
 *   npx esbuild scripts/po-probe.ts --bundle --platform=node --format=esm \
 *     --external:@anthropic-ai/claude-agent-sdk --outfile=out/po-probe.mjs
 *   node out/po-probe.mjs
 *
 * Rode de novo sempre que mexer em `PO_SYSTEM_PROMPT_OPEN` ou
 * `PO_SYSTEM_PROMPT_CLOSE`.
 */
import type { BoardItem, BoardItemStatus } from '../src/shared/ipc'
import { askPo } from '../src/main/po/po'
import {
  buildPoPrompt,
  parsePoVerdict,
  rejectUnsafeOps,
  type PoCall,
  type PoPhase
} from '../src/main/po/poPrompt'

const MODEL = 'claude-sonnet-5'

function card(id: string, title: string, status: BoardItemStatus): BoardItem {
  return {
    id,
    projectId: 'p',
    projectCwd: 'C:/proj',
    conversationId: 'conv',
    origin: 'agent',
    sourceId: id.slice(-1),
    sourceTitle: title,
    sourceStatus: status,
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
    updatedAt: ''
  }
}

interface Caso {
  nome: string
  /** Qual das duas rodadas do turno este caso exercita. */
  fase: PoPhase
  espera: 'alguma operação' | 'nada'
  userText: string
  cards: BoardItem[]
  calls: PoCall[]
}

const CASES: Caso[] = [
  // ABERTURA: o pedido acabou de chegar e nada rodou ainda — por isso os casos
  // de abertura não têm ações; é justamente a falta delas que o prompt enfrenta.
  {
    nome: 'pedido novo, quadro vazio → deve ABRIR o cartão do pedido',
    fase: 'open',
    espera: 'alguma operação',
    userText: 'cria a tela de configurações do app',
    cards: [],
    calls: []
  },
  {
    nome: 'o pedido é um cartão que está parado → deve marcar ANDAMENTO',
    fase: 'open',
    espera: 'alguma operação',
    userText: 'faz a tela de configurações do app',
    cards: [card('bi-111', 'criar a tela de configurações do app', 'pending')],
    calls: []
  },
  {
    nome: 'o pedido já está em andamento no quadro → nada a abrir de novo',
    fase: 'open',
    espera: 'nada',
    userText: 'faz a tela de configurações do app',
    cards: [card('bi-222', 'criar a tela de configurações do app', 'in_progress')],
    calls: []
  },
  {
    nome: 'ficou EM ANDAMENTO e terminou (caso central) → deve CONCLUIR',
    fase: 'close',
    espera: 'alguma operação',
    userText: 'cria a tabela do quadro e roda os testes',
    cards: [
      card('bi-aaa', 'criar a migration da tabela board_items', 'in_progress'),
      card('bi-bbb', 'documentar o quadro na ARQUITETURA.md', 'pending')
    ],
    calls: [
      { tool: 'Write', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Edit', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Bash', detail: 'npx vitest run src/main/persistence/sqliteBoard.test.ts' },
      { tool: 'Bash', detail: 'npx tsc --noEmit' }
    ]
  },
  {
    nome: 'título técnico demais → deve reescrever com TITULO',
    fase: 'close',
    espera: 'alguma operação',
    userText: 'faz o quadro de tarefas',
    cards: [card('bi-ccc', 'add board_items tbl + mig 5/7 + idx', 'in_progress')],
    calls: [{ tool: 'Edit', detail: 'src/main/persistence/sqliteSchema.ts' }]
  },
  {
    nome: 'NADA terminou — o PO não pode concluir por suposição',
    fase: 'close',
    espera: 'nada',
    userText: 'começa o quadro de tarefas',
    cards: [
      card('bi-ddd', 'criar a migration da tabela board_items', 'pending'),
      card('bi-eee', 'escrever a tela do quadro', 'pending')
    ],
    calls: [
      { tool: 'Read', detail: 'src/main/persistence/sqliteSchema.ts' },
      { tool: 'Grep', detail: 'CREATE TABLE' },
      { tool: 'Read', detail: 'docs/ARQUITETURA.md' }
    ]
  },
  {
    nome: 'tarefa já concluída pelo agente — nada a fazer',
    fase: 'close',
    espera: 'nada',
    userText: 'termina o quadro',
    cards: [card('bi-fff', 'Criar a tabela do quadro', 'completed')],
    calls: [{ tool: 'Bash', detail: 'npx vitest run' }]
  }
]

let acertos = 0
for (const caso of CASES) {
  const prompt = buildPoPrompt({
    userText: caso.userText,
    cards: caso.cards.map((c) => ({ id: c.id, title: c.sourceTitle, status: c.sourceStatus })),
    calls: caso.calls,
    phase: caso.fase
  })
  const raw = await askPo(prompt, MODEL)
  const ops = rejectUnsafeOps(
    parsePoVerdict(raw, caso.cards.map((c) => c.id), caso.fase),
    caso.cards
  )
  const obtido = ops.length > 0 ? 'alguma operação' : 'nada'
  const ok = obtido === caso.espera
  if (ok) acertos += 1
  const rodada = caso.fase === 'open' ? 'abertura' : 'fechamento'
  console.log(`\n[${ok ? 'OK ' : 'XX '}] (${rodada}) ${caso.nome}`)
  console.log(`  esperado: ${caso.espera}   obtido: ${obtido}`)
  console.log(`  cru: ${raw.replace(/\n/g, ' ⏎ ').slice(0, 260)}`)
  for (const op of ops) console.log(`  → ${JSON.stringify(op)}`)
}
console.log(`\n${acertos}/${CASES.length} casos como esperado.`)
