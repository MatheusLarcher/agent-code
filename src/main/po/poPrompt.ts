import type { BoardItemStatus } from '../../shared/ipc'
// O resumo de chamada é o MESMO do vigia, de propósito: os dois digests têm a
// mesma regra de segurança ("o alvo da ação, nunca o conteúdo"), e duas listas
// de chaves que ninguém garante iguais é como uma delas passa a vazar.
export { summarizeCall } from '../vigia/vigiaPrompt'
// O texto dos dois prompts mora em poPromptText.ts (ver o cabeçalho de lá) e
// sai reexportado daqui: quem importava de './poPrompt' continua importando.
// A seta é de mão única — poPromptText não importa nada —, então não há ciclo.
// A LEITURA do veredito (`parsePoVerdict`, `rejectUnsafeOps`) mora em
// poVerdict.ts, que importa daqui; por isso ela NÃO sai reexportada.
import { PO_RETURNED_SECTION, PO_SYSTEM_PROMPT_CLOSE, PO_SYSTEM_PROMPT_OPEN } from './poPromptText'
export {
  PO_AWAITING_AUTHORIZATION_REASON,
  PO_MAX_OPS,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN
} from './poPromptText'

/**
 * As regras puras do PO — o agente que audita o quadro.
 *
 * Ele NÃO é o autor do quadro. O esqueleto (tarefas e status) vem do snapshot
 * autoritativo do CLI; o PO só conserta o buraco que o esqueleto não cobre:
 *
 * - o pedido do usuário que nunca virou tarefa nenhuma;
 * - o cartão que o agente terminou e esqueceu de marcar;
 * - o título técnico que não diz nada a quem lê ("add board table + migration");
 * - o trabalho que aconteceu (ou ficou faltando) e nunca foi declarado.
 *
 * Tudo o que ele escreve vai com motivo e carimbo, porque uma correção
 * automática que não dá para auditar é pior do que nenhuma — e um modelo pequeno
 * vai errar alguma hora.
 */

/**
 * As duas rodadas do PO dentro de um turno.
 *
 * `open` roda quando o pedido do usuário chega: ali o quadro ainda não tem o
 * trabalho de agora, e o que importa é o pedido virar cartão ANTES de o agente
 * começar — o buraco que o fechamento sozinho nunca fechou, porque quando ele
 * roda o pedido já passou e ninguém mais sabe que ele existiu.
 *
 * `close` roda no `result`: ali o turno acabou e dá para julgar o que de fato
 * terminou. São prompts separados porque as perguntas são opostas ("o que vai
 * começar?" e "o que terminou?") e um prompt que faz as duas ao mesmo tempo
 * convida o modelo a responder a errada.
 */
export type PoPhase = 'open' | 'close'

/** Uma análise por FASE por turno, e não mais que uma por minuto na mesma
 *  conversa. O cooldown é por fase de propósito: com um contador só, a abertura
 *  gastaria a janela e o fechamento daquele turno nunca rodaria. */
export const PO_COOLDOWN_MS = 60_000
/**
 * A retentativa de uma análise que passou do cooldown e NÃO chegou ao fim
 * (modelo fora, Luna indisponível, quadro ilegível, exceção). Sem ela, a
 * evidência que voltou para a fila só era julgada no PRÓXIMO turno — e o turno
 * que terminou a conversa não tem próximo: a tarefa concluída ficava "em
 * andamento" no quadro até alguém voltar a falar. O intervalo é o do cooldown
 * de propósito: a retentativa nunca consulta o modelo com mais frequência do
 * que um turno real consultaria.
 */
export const PO_RETRY_DELAY_MS = 60_000
/** Retentativas SEGUIDAS por fase. O teto existe porque uma falha que dura
 *  (chave revogada, quadro fora do ar) não pode virar uma consulta por minuto
 *  para sempre; esgotado, a evidência continua na fila para o próximo turno ou
 *  para o `dispose`, como antes da retentativa existir. */
export const PO_MAX_RETRIES = 2
/** Tetos do digest: o custo não pode crescer com o tamanho da conversa. */
export const PO_MAX_USER_CHARS = 1200
/**
 * Numa sessão longa e cheia de delegação (dezenas de turnos por hora, cada
 * um com um subagente), o cooldown de 60s pula quase todo fechamento e
 * `mergeDeferred` mantém só as ÚLTIMAS ações de todos os turnos acumulados.
 * Com o teto antigo (20), a evidência de "o arquivo foi escrito, o teste
 * rodou" que provava a conclusão de um cartão saía da janela bem antes de o
 * cooldown liberar uma análise — e o PO, corretamente pela própria regra
 * ("só conclua com evidência"), nunca tinha motivo para marcar CONCLUIR.
 * 60 não elimina o limite, mas dá margem para o volume real deste modo de
 * trabalho sem inflar o prompt a cada turno de uma sessão comum.
 */
export const PO_MAX_CALLS = 60
/** Teto de UMA linha de ação no digest (`ferramenta: alvo`) — o mesmo do gate
 *  (`BOARD_GATE_MAX_CALL_CHARS`), para o gate nunca ver menos da ação do que o
 *  modelo que ele dispensa. Sem ele, um `Grep` ou um caminho enorme furava o
 *  teto total: `summarizeCall` só corta o Bash e o caso genérico. */
export const PO_MAX_CALL_CHARS = 200
export const PO_MAX_CARDS = 30
/** Teto de UMA linha do quadro (`id [status] título`). O id vem primeiro de
 *  propósito: num id fora do padrão (os do quadro têm até 23 caracteres, ver
 *  boardModel.ts), o corte come o fim do título, nunca o id que o modelo cita. */
export const PO_MAX_CARD_LINE_CHARS = 140
/** Teto da seção de tarefas do registro (mcp__tasks) no digest — mesmo
 *  espírito de PO_MAX_CARDS: uma lista longa não ajuda o modelo a decidir.
 *  QUAIS entram, quando a conversa tem mais, é `pickLedgerTasks`. */
export const PO_MAX_LEDGER_TASKS = 15
/** Teto de UMA linha de tarefa (`título [status]`): título + " [cancelled]", o
 *  status mais longo do registro, cabem; só um status estranho seria cortado. */
export const PO_MAX_TASK_LINE_CHARS = 110
export const PO_MAX_TITLE_CHARS = 90
/**
 * Teto da seção de trabalho em SEGUNDO PLANO (o snapshot `background-tasks` do
 * SDK no instante do `result`): subagentes e comandos que o agente delegou e
 * que continuam rodando depois do turno. Poucos de propósito — o modelo só
 * precisa saber QUE o trabalho continua e qual é o assunto, e numa conversa
 * normal há um ou dois. Passando do teto, entram os primeiros do snapshot.
 */
export const PO_MAX_BACKGROUND_TASKS = 5
/** Teto de UMA linha de tarefa em segundo plano (a descrição do SDK). */
export const PO_MAX_BACKGROUND_LINE_CHARS = 110
/** Tetos da seção dos cartões que o fim do turno devolve para "a fazer" — só
 *  ids (o título já está no QUADRO ATUAL). Escolhidos para a seção inteira
 *  caber no espaço da de segundo plano, com quem ela nunca aparece junto. */
export const PO_MAX_RETURNED_CARDS = 8
export const PO_MAX_RETURNED_LINE_CHARS = 60
/**
 * Teto da última resposta do agente, com o "…" do corte (~250 tokens). A que
 * cabe vai inteira; a longa leva as DUAS pontas: PO_REPLY_HEAD_CHARS do início,
 * "…" no meio e o resto do fim — o mesmo fim de antes (599), onde ficam a
 * conclusão e a pergunta. Só o fim não bastava: no fechamento das 14:54 (UTC)
 * de "Cadastro no sistema" a prova de que o EXE com o e-mail embutido foi
 * testado estava no INÍCIO, e o PO concluiu o cartão ERRADO (o do login Google).
 *
 * Mesmo corte nas DUAS fases: na abertura pesa a pergunta do fim ("pode fazer"
 * responde a ela), que fica igual, e o início diz o que já foi entregue — o que
 * separa o cartão concluído do "a fazer" do passo proposto. O gate (`clampEnds`
 * em boardGate.ts) leva no mínimo isto de cada ponta.
 */
export const PO_MAX_REPLY_CHARS = 1_000
/** Quanto do INÍCIO da resposta entra quando ela passa do teto. */
export const PO_REPLY_HEAD_CHARS = 400
/** O que sobra para o FIM: o teto menos o início e o "…". */
export const PO_REPLY_TAIL_CHARS = PO_MAX_REPLY_CHARS - PO_REPLY_HEAD_CHARS - 1

/** Os rótulos das seções do digest — contados no teto total. */
const LABEL_USER = 'PEDIDO DO USUÁRIO:'
const LABEL_CARDS = 'QUADRO ATUAL:'
const LABEL_CALLS = 'AÇÕES DESTE TURNO:'
const LABEL_BACKGROUND = 'TRABALHO EM SEGUNDO PLANO AINDA RODANDO:'
const LABEL_REPLY = 'ÚLTIMA RESPOSTA DO AGENTE:'
const LABEL_TASKS = 'TAREFAS DO REGISTRO NESTA CONVERSA:'
/** Exportado: o prompt de fechamento cita esta seção pelo nome. */
export const LABEL_RETURNED = PO_RETURNED_SECTION
/** O marcador das linhas de ação, de tarefa e de segundo plano. */
const LIST_MARK = '- '

/**
 * O teto TOTAL do digest: o custo de uma análise não pode crescer com o tamanho
 * da conversa. A conta do PIOR caso, somando os tetos acima:
 *
 * ```
 *   1.200  pedido                 (PO_MAX_USER_CHARS)
 *   4.200  quadro                 (30 × 140)
 *  12.120  ações                  (60 × 202: "- " + 200)
 *     560  segundo plano          (5 × 112: "- " + 110)
 *   1.000  resposta               (400 do início + "…" + 599 do fim)
 *   1.680  tarefas do registro    (15 × 112: "- " + 110)
 *     150  rótulos das 6 seções
 *     122  quebras de linha       (123 linhas no pior caso)
 *  ------
 *  21.032  caracteres
 * ```
 *
 * Em português, ~5k–7k tokens. Quem mexer em qualquer teto daqui tem que refazer
 * esta conta — o teste do pior caso (poDigest.test.ts) monta um digest com
 * TODOS os tetos estourados e exige que ele feche exatamente neste número.
 */
export const PO_MAX_DIGEST_CHARS =
  PO_MAX_USER_CHARS +
  PO_MAX_CARDS * PO_MAX_CARD_LINE_CHARS +
  PO_MAX_CALLS * (LIST_MARK.length + PO_MAX_CALL_CHARS) +
  PO_MAX_BACKGROUND_TASKS * (LIST_MARK.length + PO_MAX_BACKGROUND_LINE_CHARS) +
  PO_MAX_REPLY_CHARS +
  PO_MAX_LEDGER_TASKS * (LIST_MARK.length + PO_MAX_TASK_LINE_CHARS) +
  [LABEL_USER, LABEL_CARDS, LABEL_CALLS, LABEL_BACKGROUND, LABEL_REPLY, LABEL_TASKS].join('').length +
  // 6 rótulos + pedido + cartões + ações + segundo plano + resposta + tarefas
  // + 5 linhas em branco entre as seções: 123 linhas, ligadas por 122 quebras.
  (6 + 1 + PO_MAX_CARDS + PO_MAX_CALLS + PO_MAX_BACKGROUND_TASKS + 1 + PO_MAX_LEDGER_TASKS + 5) - 1

export interface PoCall {
  tool: string
  detail: string
}

/** Colapsa espaços e corta no teto, com "…" no lugar do que sobrou. Exportado
 *  para poVerdict.ts cortar motivo e título com a MESMA regra do digest. */
export function clamp(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Como `clamp`, mas guardando as DUAS pontas: `head` caracteres do início, um
 * "…" no lugar do meio e o resto do teto com o fim. O meio de uma resposta
 * longa é o relato passo a passo; a entrega costuma abrir o texto e a pergunta
 * ao usuário, fechá-lo. Mesma regra do `clampEnds` do gate.
 */
function clampEnds(text: string, max: number, head: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, head)}…${clean.slice(clean.length - (max - head - 1))}`
}

function statusLabel(status: BoardItemStatus): string {
  if (status === 'completed') return 'concluída'
  if (status === 'in_progress') return 'em andamento'
  return 'a fazer'
}

/** Uma tarefa do registro (mcp__tasks), reduzida ao que o PO precisa: título e
 *  status. `done`/`failed` são evidência DURÁVEL de que algo aconteceu — ao
 *  contrário do histórico de ações, não se perde no teto de PO_MAX_CALLS
 *  quando o cooldown empurra a análise para muitos turnos à frente. */
export interface PoLedgerTask {
  title: string
  status: string
}

/**
 * QUAIS tarefas do registro entram no digest quando a conversa tem mais do que
 * PO_MAX_LEDGER_TASKS. A lista chega em ordem CRONOLÓGICA (a mais antiga
 * primeiro: é a ordem do registro, `ORDER BY created_at, id`).
 *
 * O critério, nesta ordem:
 * 1. `done` e as abertas (pending/running/review/blocked) antes de
 *    `failed`/`cancelled`. A `done` é a prova de que um trabalho terminou — é
 *    ela que sustenta um CONCLUIR — e a aberta diz o que ainda falta, que é o
 *    que segura o CONCLUIR no cartão errado. A que falhou ou foi cancelada só
 *    entra se sobrar vaga.
 * 2. Dentro de cada grupo, as mais RECENTES. Numa conversa longa as antigas são
 *    de pedidos que o quadro já resolveu; o turno que o PO julga agora é o do fim.
 *
 * As escolhidas saem na ordem cronológica original, para o modelo ler a
 * história na sequência em que aconteceu. Dentro do teto, a lista sai igual —
 * o que torna a função idempotente: `listConvTasks` já a aplica (é o que
 * alimenta o gate) e o digest aplica de novo sem mudar nada.
 */
export function pickLedgerTasks(tasks: readonly PoLedgerTask[]): PoLedgerTask[] {
  if (tasks.length <= PO_MAX_LEDGER_TASKS) return [...tasks]
  const rank = (task: PoLedgerTask): number => (task.status === 'failed' || task.status === 'cancelled' ? 1 : 0)
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => rank(a.task) - rank(b.task) || b.index - a.index)
    .slice(0, PO_MAX_LEDGER_TASKS)
    .sort((a, b) => a.index - b.index)
    .map(({ task }) => task)
}

/** A fase é opcional e cai em `close` porque o fechamento é o PO que já existia:
 *  quem chamava antes da abertura existir continua recebendo o mesmo prompt. */
export function buildPoDigest(input: {
  userText: string
  cards: { id: string; title: string; status: BoardItemStatus }[]
  calls: PoCall[]
  phase?: PoPhase
  ledgerTasks?: PoLedgerTask[]
  /** O último texto final do agente: a do turno no fechamento, a do turno
   *  anterior na abertura. */
  agentReply?: string | null
  /** As descrições do que ainda roda em segundo plano (snapshot
   *  `background-tasks`). Só o fechamento as mostra. */
  background?: readonly string[]
}): string {
  const cards = input.cards.slice(0, PO_MAX_CARDS)
  // As ÚLTIMAS ações, não as primeiras: a evidência do que terminou está no fim
  // do turno — o mesmo critério de `observe`, `mergeDeferred` e do gate. Com as
  // primeiras, um turno longo mostrava as leituras do começo e escondia o teste
  // e o build do fim.
  const calls = input.calls.slice(-PO_MAX_CALLS)
  const lines = [
    LABEL_USER,
    clamp(input.userText, PO_MAX_USER_CHARS) || '(sem texto)',
    '',
    LABEL_CARDS,
    ...(cards.length === 0
      ? ['(vazio)']
      : cards.map((card) =>
          clamp(`${card.id} [${statusLabel(card.status)}] ${clamp(card.title, PO_MAX_TITLE_CHARS)}`, PO_MAX_CARD_LINE_CHARS)
        ))
  ]
  // Na abertura o turno ainda não aconteceu. Uma seção de ações sempre vazia só
  // ensinaria o modelo a procurar evidência que não existe — e evidência
  // imaginada é exatamente o erro que as barreiras tentam impedir.
  if ((input.phase ?? 'close') === 'close') {
    lines.push(
      '',
      LABEL_CALLS,
      ...(calls.length === 0
        ? ['(nenhuma)']
        : calls.map((call) => `${LIST_MARK}${clamp(`${call.tool}: ${call.detail}`, PO_MAX_CALL_CHARS)}`))
    )
    // O turno do agente principal acabou, mas o trabalho que ele DELEGOU não:
    // sem esta seção, "em andamento" no fim do turno parece trabalho parado. Só
    // com algo rodando — vazia, ensinaria o modelo a esperar por ela.
    const background = (input.background ?? [])
      .map((text) => clamp(text, PO_MAX_BACKGROUND_LINE_CHARS))
      .filter(Boolean)
      .slice(0, PO_MAX_BACKGROUND_TASKS)
    if (background.length > 0) lines.push('', LABEL_BACKGROUND, ...background.map((text) => `${LIST_MARK}${text}`))
    // O que o fim do turno vai devolver para "a fazer" (tudo o que ficou "em
    // andamento"), para o PO justificar cada um com PENDENTE ou concluir.
    // Mutuamente exclusiva com a seção acima: com trabalho em segundo plano o
    // fechamento é delegado e nada é devolvido — e é por isso que esta seção
    // (menor que a de segundo plano) não mexe no teto total do digest.
    const returned =
      background.length > 0
        ? []
        : cards.filter((card) => card.status === 'in_progress').slice(0, PO_MAX_RETURNED_CARDS)
    if (returned.length > 0) {
      lines.push('', LABEL_RETURNED, ...returned.map((card) => `${LIST_MARK}${clamp(card.id, PO_MAX_RETURNED_LINE_CHARS)}`))
    }
  }
  // O alvo das ferramentas não mostra o resultado de uma pesquisa nem a
  // pergunta que deixou o trabalho esperando o usuário — a resposta mostra.
  // Sem texto, sem seção: o digest fica exatamente como era.
  const reply = clampEnds(input.agentReply ?? '', PO_MAX_REPLY_CHARS, PO_REPLY_HEAD_CHARS)
  if (reply) lines.push('', LABEL_REPLY, reply)
  // Só aparece quando há algo a mostrar: uma seção vazia ensinaria o modelo a
  // esperar por uma fonte de evidência que não existe nesta conversa.
  const ledgerTasks = pickLedgerTasks(input.ledgerTasks ?? [])
  if (ledgerTasks.length > 0) {
    lines.push(
      '',
      LABEL_TASKS,
      ...ledgerTasks.map(
        (task) => `${LIST_MARK}${clamp(`${clamp(task.title, PO_MAX_TITLE_CHARS)} [${task.status}]`, PO_MAX_TASK_LINE_CHARS)}`
      )
    )
  }
  return lines.join('\n')
}

export function buildPoPrompt(input: Parameters<typeof buildPoDigest>[0]): string {
  const rules = input.phase === 'open' ? PO_SYSTEM_PROMPT_OPEN : PO_SYSTEM_PROMPT_CLOSE
  return `${rules}\n\n---\n\n${buildPoDigest(input)}`
}
