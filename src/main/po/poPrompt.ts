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
import {
  PO_ETAPA_RULES,
  PO_ETAPA_SECTION,
  PO_MESSAGES_SECTION,
  PO_ORPHAN_RULES,
  PO_ORPHAN_SECTION,
  PO_PREVIOUS_REPLY_SECTION,
  PO_REPLY_SECTION,
  PO_RESUMED_MARK,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN,
  PO_USER_SECTION
} from './poPromptText'
import { formatPoGitEvidence, type PoGitEvidence } from './poGit'
import { cutMiddle, formatTurnMessages, PO_MAX_SECTION_CHARS, type PoTurnLog } from './poTurnText'
export {
  PO_AWAITING_AUTHORIZATION_REASON,
  PO_ETAPA_RULES,
  PO_ETAPA_SECTION,
  PO_MAX_OPS,
  PO_MESSAGES_SECTION,
  PO_ORPHAN_RULES,
  PO_ORPHAN_SECTION,
  PO_PREVIOUS_REPLY_SECTION,
  PO_REPLY_SECTION,
  PO_RESUMED_MARK,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN,
  PO_USER_SECTION
} from './poPromptText'
export { PO_MAX_SECTION_CHARS, type PoTurnLog } from './poTurnText'
// Só o TIPO (apagado na compilação): poPrompt.ts continua sem importar código do acompanhamento.
import type { PoEnvioEtapa } from '../handoffTracking/handoffOrphans'
export type { PoEnvioEtapa } from '../handoffTracking/handoffOrphans'

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
/** Tetos do digest: o custo não pode crescer com o tamanho da conversa. O da
 *  mensagem do usuário é o teto de SEGURANÇA de seção (poTurnText.ts): o texto
 *  vai inteiro, e só um pedido patológico é cortado — pelo meio, com aviso. */
export const PO_MAX_USER_CHARS = PO_MAX_SECTION_CHARS
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
/*
 * A resposta final do agente NÃO tem teto: é por ela que o PO decide se o
 * cartão do pedido conclui ou fica pendente, e um recorte dela (o antigo corte
 * de 1.000 caracteres, as duas pontas com "…") escondia justamente o "falta X"
 * do meio. As mensagens intermediárias têm o teto de segurança de seção.
 */

/** Os rótulos das seções do digest — contados no teto total. Os de texto do
 *  turno moram em poPromptText.ts, que os cita pelo nome nas regras. */
const LABEL_USER = PO_USER_SECTION
const LABEL_CARDS = 'QUADRO ATUAL:'
const LABEL_CALLS = 'AÇÕES DESTE TURNO:'
const LABEL_BACKGROUND = 'TRABALHO EM SEGUNDO PLANO AINDA RODANDO:'
const LABEL_MESSAGES = PO_MESSAGES_SECTION
const LABEL_REPLY = PO_REPLY_SECTION
const LABEL_TASKS = 'TAREFAS DO REGISTRO NESTA CONVERSA:'
/** Exportado: o prompt de fechamento cita esta seção pelo nome. */
export const LABEL_RETURNED = PO_RETURNED_SECTION
/** O marcador das linhas de ação, de tarefa e de segundo plano. */
const LIST_MARK = '- '

/**
 * O teto TOTAL do digest, FORA o texto da resposta final (que vai inteiro, sem
 * teto — ver acima): o resto não pode crescer com o tamanho da conversa. A conta
 * do PIOR caso, somando os tetos acima:
 *
 * ```
 *  60.000  mensagem do usuário    (PO_MAX_USER_CHARS = PO_MAX_SECTION_CHARS)
 *   4.200  quadro                 (30 × 140)
 *  12.120  ações                  (60 × 202: "- " + 200)
 *     560  segundo plano          (5 × 112: "- " + 110)
 *  60.000  mensagens do agente    (PO_MAX_SECTION_CHARS)
 *   1.680  tarefas do registro    (15 × 112: "- " + 110)
 *     232  rótulos das 7 seções
 *     125  quebras de linha       (126 linhas no pior caso)
 *  ------
 * 138.917  caracteres + a resposta final
 * ```
 *
 * Os 60k por seção são teto de SEGURANÇA, não o tamanho normal: um turno comum
 * fica na casa dos poucos milhares. Quem mexer em qualquer teto daqui tem que
 * refazer esta conta — o teste do pior caso (poDigest.test.ts) monta um digest
 * com TODOS os tetos estourados e exige que ele feche exatamente neste número
 * mais o tamanho da resposta final.
 */
export const PO_MAX_DIGEST_CHARS =
  PO_MAX_USER_CHARS +
  PO_MAX_CARDS * PO_MAX_CARD_LINE_CHARS +
  PO_MAX_CALLS * (LIST_MARK.length + PO_MAX_CALL_CHARS) +
  PO_MAX_BACKGROUND_TASKS * (LIST_MARK.length + PO_MAX_BACKGROUND_LINE_CHARS) +
  PO_MAX_SECTION_CHARS +
  PO_MAX_LEDGER_TASKS * (LIST_MARK.length + PO_MAX_TASK_LINE_CHARS) +
  [LABEL_USER, LABEL_CARDS, LABEL_CALLS, LABEL_BACKGROUND, LABEL_MESSAGES, LABEL_REPLY, LABEL_TASKS].join('').length +
  // 7 rótulos + pedido + cartões + ações + segundo plano + mensagens + resposta
  // + tarefas + 6 linhas em branco entre as seções: 126 linhas, 125 quebras.
  (7 + 1 + PO_MAX_CARDS + PO_MAX_CALLS + PO_MAX_BACKGROUND_TASKS + 1 + 1 + PO_MAX_LEDGER_TASKS + 6) - 1

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
  /** A resposta final do agente, INTEIRA: a do turno que acabou no fechamento,
   *  a do turno anterior na abertura (com rótulo próprio). */
  agentReply?: string | null
  /** Só no fechamento: o que o agente principal escreveu no turno ANTES da
   *  resposta final, em ordem. */
  agentMessages?: readonly string[]
  /** Só no fechamento: os turnos adiados pelo cooldown que este julga junto,
   *  do mais antigo para o mais novo — cada um com rótulo próprio. */
  earlierTurns?: readonly PoTurnLog[]
  /** As descrições do que ainda roda em segundo plano (snapshot
   *  `background-tasks`). Só o fechamento as mostra. */
  background?: readonly string[]
  /** Os ids da seção de devolvidos, já escolhidos pela rodada
   *  (`poReturnedCards`). Ausente: os "em andamento" do quadro, como sempre. */
  returned?: readonly string[]
  /** Dos devolvidos, os que só a mensagem do usuário retomou: saem com a marca
   *  `PO_RESUMED_MARK` (o prompt diz o que fazer com eles). */
  resumed?: readonly string[]
}): string {
  const cards = input.cards.slice(0, PO_MAX_CARDS)
  // As ÚLTIMAS ações, não as primeiras: a evidência do que terminou está no fim
  // do turno — o mesmo critério de `observe`, `mergeDeferred` e do gate. Com as
  // primeiras, um turno longo mostrava as leituras do começo e escondia o teste
  // e o build do fim.
  const calls = input.calls.slice(-PO_MAX_CALLS)
  const lines = [
    LABEL_USER,
    // Inteira e com as quebras de linha: só o teto de segurança corta (pelo meio).
    cutMiddle(input.userText ?? '', PO_MAX_USER_CHARS) || '(sem texto)',
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
    // O que o fim do turno julga (o que ficou "em andamento"): sem PENDENTE,
    // vira concluído pelo padrão (poCloseDefault.ts). Mutuamente exclusiva com
    // a seção acima: com trabalho em segundo plano o fechamento é delegado e
    // nada é julgado — e é por isso que esta seção (menor que a de segundo
    // plano) não mexe no teto total do digest.
    const returned =
      background.length > 0
        ? []
        : (input.returned ?? cards.filter((card) => card.status === 'in_progress').map((card) => card.id)).slice(
            0,
            PO_MAX_RETURNED_CARDS
          )
    if (returned.length > 0) {
      const resumed = new Set(input.resumed ?? [])
      const line = (id: string): string => (resumed.has(id) ? `${id} ${PO_RESUMED_MARK}` : id)
      lines.push('', LABEL_RETURNED, ...returned.map((id) => `${LIST_MARK}${clamp(line(id), PO_MAX_RETURNED_LINE_CHARS)}`))
    }
    // O que o agente principal disse ao longo do turno, antes da resposta final.
    // Sem nada, sem seção.
    const messages = formatTurnMessages(input.earlierTurns ?? [], input.agentMessages ?? [])
    if (messages) lines.push('', LABEL_MESSAGES, messages)
  }
  // A resposta final, INTEIRA e sem teto: é por ela que o PO decide o cartão do
  // pedido (poPromptText.ts). Na abertura é a do turno anterior, com o rótulo
  // dizendo isso. Sem texto, sem seção.
  const reply = (input.agentReply ?? '').trim()
  if (reply) lines.push('', (input.phase ?? 'close') === 'close' ? LABEL_REPLY : PO_PREVIOUS_REPLY_SECTION, reply)
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

/** Uma etapa do prompt deste turno sem cartão no quadro (handoffOrphans.ts). */
export interface PoOrphanEtapa {
  etapaId: string
  titulo: string
}

/** Teto da seção das etapas sem cartão; cada linha leva `[id] título` no corte
 *  do título do cartão (PO_MAX_TITLE_CHARS), para a cópia do PO caber igual. */
export const PO_MAX_ORPHANS = 10

/** A seção das etapas sem cartão, com a regra FEITA/NOVA junto (poPromptText.ts). */
export function formatPoOrphanEtapas(orphans: readonly PoOrphanEtapa[]): string {
  const lines = orphans
    .slice(0, PO_MAX_ORPHANS)
    .map((orphan) => `${LIST_MARK}${clamp(`[${orphan.etapaId}] ${orphan.titulo}`, PO_MAX_TITLE_CHARS)}`)
  return [PO_ORPHAN_SECTION, ...lines, PO_ORPHAN_RULES].join('\n')
}

/** Teto da seção do placar (`PoEnvioEtapa`, handoffOrphans.ts). Um prompt de
 *  handoff raramente passa de uma dúzia de etapas; passando, entram as
 *  primeiras do envio — a ordem do roteiro. */
export const PO_MAX_ENVIO_ETAPAS = 12
/** Teto de UMA linha do placar: `[id] título — placar — cartão — aceite —
 *  verificar com`. O começo (id, título no corte do cartão, placar e cartão)
 *  vai inteiro; o que sobra é repartido entre o aceite e o "verificar com",
 *  para o segundo não sumir atrás de um aceite comprido. */
export const PO_MAX_ETAPA_LINE_CHARS = 320

const ENTREGA_LABEL: Record<PoEnvioEtapa['status'], string> = {
  pendente: 'pendente',
  em_andamento: 'em andamento',
  concluida: 'concluída',
  incompleta: 'incompleta'
}
const NOT_DECLARED = 'não declarado'

/** Reparte `budget` entre dois textos: cada um tem direito à metade, e a sobra
 *  do mais curto vai para o outro. */
function share(a: string, b: string, budget: number): [string, string] {
  const half = Math.floor(budget / 2)
  return [clamp(a, Math.max(1, half, budget - b.length)), clamp(b, Math.max(1, budget - half, budget - a.length))]
}

/** A seção do placar, com a regra ETAPA CONCLUÍDA/PENDENTE junto (poPromptText.ts). */
export function formatPoEnvioEtapas(etapas: readonly PoEnvioEtapa[]): string {
  const lines = etapas.slice(0, PO_MAX_ENVIO_ETAPAS).map((etapa) => {
    const card = etapa.card
      ? `cartão ${etapa.card.id}: ${statusLabel(etapa.card.status)}${etapa.card.contested ? ', contestado pelo PO' : ''}`
      : `cartão: nenhum (resolva na seção ${PO_ORPHAN_SECTION.replace(/:$/, '')})`
    const head = `[${etapa.etapaId}] ${clamp(etapa.titulo, PO_MAX_TITLE_CHARS)} — placar: ${ENTREGA_LABEL[etapa.status]} — ${card} — aceite: `
    const sep = ' — verificar com: '
    const budget = PO_MAX_ETAPA_LINE_CHARS - head.length - sep.length
    const [aceite, verificarCom] = share(etapa.aceite ?? NOT_DECLARED, etapa.verificarCom ?? NOT_DECLARED, budget)
    return `${LIST_MARK}${clamp(`${head}${aceite}${sep}${verificarCom}`, PO_MAX_ETAPA_LINE_CHARS)}`
  })
  return [PO_ETAPA_SECTION, ...lines, PO_ETAPA_RULES].join('\n')
}

export function buildPoPrompt(
  input: Parameters<typeof buildPoDigest>[0] & {
    /** O git da pasta (poGit.ts). Fica DEPOIS do digest e com teto próprio
     *  (`PO_GIT_SECTION_MAX_CHARS`): o teto do digest continua o documentado. */
    git?: PoGitEvidence | null
    /** Só no fechamento: as etapas do prompt sem cartão. Como o git, fica
     *  depois do digest e com teto próprio (PO_MAX_ORPHANS); vazia, a seção some. */
    orphans?: readonly PoOrphanEtapa[]
    /** Só no fechamento: o placar do envio corrente (toda etapa, com cartão e
     *  aceite). Como as órfãs: depois do digest, teto próprio
     *  (PO_MAX_ENVIO_ETAPAS); vazio, a seção some e o prompt fica como era. */
    envioEtapas?: readonly PoEnvioEtapa[]
  }
): string {
  const rules = input.phase === 'open' ? PO_SYSTEM_PROMPT_OPEN : PO_SYSTEM_PROMPT_CLOSE
  const close = (input.phase ?? 'close') === 'close'
  const placar = close && input.envioEtapas?.length ? `\n\n${formatPoEnvioEtapas(input.envioEtapas)}` : ''
  const orphans = close && input.orphans?.length ? `\n\n${formatPoOrphanEtapas(input.orphans)}` : ''
  const git = input.git ? `\n\n${formatPoGitEvidence(input.git)}` : ''
  return `${rules}\n\n---\n\n${buildPoDigest(input)}${placar}${orphans}${git}`
}
