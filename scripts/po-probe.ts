/**
 * Prova de campo do PO: roda o prompt REAL contra o modelo real, em casos
 * opostos, e imprime as operações já passadas pelo parser e pelas barreiras.
 *
 * Existe pelo mesmo motivo do `vigia-probe.ts`: o teste unitário prova o
 * parser, não a qualidade do prompt — e aqui a qualidade do prompt decide se o
 * quadro fica honesto ou se enche de conclusão errada. O caso que mais importa
 * é o terceiro: o PO NÃO pode concluir o que não terminou.
 *
 * Bundlar com esbuild e rodar:
 *   npx esbuild scripts/po-probe.ts --bundle --platform=node --format=esm \
 *     --external:@anthropic-ai/claude-agent-sdk --outfile=out/po-probe.mjs
 *   node out/po-probe.mjs
 *
 * Rode de novo sempre que mexer no `PO_SYSTEM_PROMPT`.
 */
import type { BoardItem, BoardItemStatus } from '../src/shared/ipc'
import { askPo } from '../src/main/po/po'
import { buildPoPrompt, parsePoVerdict, rejectUnsafeOps, type PoCall } from '../src/main/po/poPrompt'

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
  espera: 'alguma operação' | 'nada'
  userText: string
  cards: BoardItem[]
  calls: PoCall[]
}

const CASES: Caso[] = [
  {
    nome: 'ficou EM ANDAMENTO e terminou (caso central) → deve CONCLUIR',
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
    espera: 'alguma operação',
    userText: 'faz o quadro de tarefas',
    cards: [card('bi-ccc', 'add board_items tbl + mig 5/7 + idx', 'in_progress')],
    calls: [{ tool: 'Edit', detail: 'src/main/persistence/sqliteSchema.ts' }]
  },
  {
    nome: 'NADA terminou — o PO não pode concluir por suposição',
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
    calls: caso.calls
  })
  const raw = await askPo(prompt, MODEL)
  const ops = rejectUnsafeOps(parsePoVerdict(raw, caso.cards.map((c) => c.id)), caso.cards)
  const obtido = ops.length > 0 ? 'alguma operação' : 'nada'
  const ok = obtido === caso.espera
  if (ok) acertos += 1
  console.log(`\n[${ok ? 'OK ' : 'XX '}] ${caso.nome}`)
  console.log(`  esperado: ${caso.espera}   obtido: ${obtido}`)
  console.log(`  cru: ${raw.replace(/\n/g, ' ⏎ ').slice(0, 260)}`)
  for (const op of ops) console.log(`  → ${JSON.stringify(op)}`)
}
console.log(`\n${acertos}/${CASES.length} casos como esperado.`)
