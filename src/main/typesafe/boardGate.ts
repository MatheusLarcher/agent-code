import { noul } from '@typesafe-ai/sdk'
import { askTypeSafe, typeSafeApiKey, typeSafeEnabled, typeSafeMinConfidence, type AskTypeSafeOptions } from './client'

/**
 * O gate que decide se vale gastar o LLM do PO numa rodada do quadro.
 *
 * O PO consulta um modelo de conversa na ABERTURA e no FECHAMENTO de todo turno,
 * e uma boa parte dessas rodadas termina em "OK, nada a mudar": a pergunta sobre
 * o build que não vira cartão, o "valeu" do fim da conversa. Esta pergunta
 * binária ao Jev custa ~100ms e alguns tokens; ela roda antes, e o modelo caro
 * só roda quando ela não disser um "não" claro.
 *
 * A mesma regra do gate de memória, e pelo mesmo motivo: **ausência de decisão
 * não é "não"**. Sem chave, desligado, timeout ou erro devolvem `null`, e `null`
 * significa "siga como antes" — o PO consulta o modelo como sempre consultou.
 * Uma falha no TypeSafe jamais pode virar "o quadro parou de ser auditado".
 */

/**
 * O que o gate vê: o mesmo material do digest do PO, só texto. Nada daqui vira
 * escrita, e tudo é cortado antes de sair da máquina.
 */
export interface BoardGateInput {
  /** Abertura (o pedido chegou) ou fechamento (o turno acabou): cada uma tem a
   *  SUA pergunta, porque o PO faz perguntas opostas nas duas. */
  phase: 'open' | 'close'
  /** O pedido — já mesclado com o que o cooldown adiou, como o PO vai ver. */
  userText: string
  /** Os cartões do quadro desta conversa, com o status efetivo. */
  cards: readonly { title: string; status: string }[]
  /** O alvo das ações do turno (nunca conteúdo). Vazio na abertura. */
  calls: readonly { tool: string; detail: string }[]
  /** As tarefas do registro (mcp__tasks) ligadas a esta conversa. */
  ledgerTasks: readonly { title: string; status: string }[]
}

/**
 * Tetos do `state`. O limite do Jev é 32k TOKENS.
 *
 * A conta do PIOR caso, somando os tetos abaixo:
 *
 * ```
 *   4.000  pedido_do_usuario
 *   4.800  quadro                 (30 × 160)
 *  12.000  acoes_do_turno         (60 × 200)
 *   2.400  tarefas_do_registro    (15 × 160)
 *  ------
 *  23.200  caracteres
 * ```
 *
 * Mais três contadores numéricos (`*_omitidos`), que não pesam. Em português,
 * 23,2k caracteres ficam na faixa de 6k–8k tokens: folga de ~4x sobre os 32k.
 * Os tetos de quantidade acompanham os do digest do PO (30 cartões, 60 ações, 15
 * tarefas) de propósito — o gate não pode decidir "não" olhando MENOS evidência
 * do que o modelo que ele está dispensando veria. Quem mexer em qualquer teto
 * daqui precisa refazer esta conta: um `state` recusado por tamanho é uma decisão
 * perdida em TODA rodada, e a falha degrada em silêncio.
 */
export const BOARD_GATE_MAX_USER_CHARS = 4_000
export const BOARD_GATE_MAX_CARDS = 30
export const BOARD_GATE_MAX_CARD_CHARS = 160
export const BOARD_GATE_MAX_CALLS = 60
export const BOARD_GATE_MAX_CALL_CHARS = 200
export const BOARD_GATE_MAX_TASKS = 15
export const BOARD_GATE_MAX_TASK_CHARS = 160

/** O teto que a conta acima produz. Exportado para o teste manter os dois em dia. */
export const BOARD_GATE_MAX_STATE_CHARS =
  BOARD_GATE_MAX_USER_CHARS +
  BOARD_GATE_MAX_CARDS * BOARD_GATE_MAX_CARD_CHARS +
  BOARD_GATE_MAX_CALLS * BOARD_GATE_MAX_CALL_CHARS +
  BOARD_GATE_MAX_TASKS * BOARD_GATE_MAX_TASK_CHARS

/**
 * A pergunta da ABERTURA. Espelha a regra do prompt de abertura do PO: só vira
 * cartão o que é trabalho, e continuação de trabalho que já tem cartão também é
 * trabalho — sem essa ressalva, o "continua" solto seria lido como conversa e o
 * cartão "a fazer" nunca voltaria para "em andamento".
 */
export const BOARD_GATE_OPEN_QUESTION =
  'O PEDIDO DO USUÁRIO é trabalho que deve aparecer no quadro de tarefas — começa ou retoma uma tarefa ' +
  'no projeto (mudar código, corrigir, criar, investigar para depois mudar, ou continuar um trabalho que ' +
  'já tem cartão no QUADRO)? Responda não quando for pergunta, pedido de opinião ou de explicação, ' +
  'agradecimento, pedido de status ou conversa.'

/**
 * A pergunta do FECHAMENTO. Deliberadamente inclinada para o "sim": o que ela
 * dispensa é a auditoria que conserta o cartão esquecido, e um "não" errado aqui
 * deixa o quadro mentindo até o próximo turno. Só o turno de conversa pura, sem
 * trabalho nenhum, é "não".
 */
export const BOARD_GATE_CLOSE_QUESTION =
  'Este turno mudou o estado de algum trabalho — terminou, começou ou revelou uma tarefa que não está ' +
  'registrada no QUADRO — ou existe cartão no QUADRO com status errado diante das AÇÕES DO TURNO e das ' +
  'TAREFAS DO REGISTRO? Responda não só quando o turno foi conversa, sem trabalho nenhum.'

/** Descrições dos dois lados, por fase: o Jev calibra melhor com o que cada
 *  resposta significa, e o significado muda de uma rodada para a outra. */
const BOARD_GATE_CRITERIA = {
  open: {
    true: 'O pedido começa ou retoma trabalho no projeto; o quadro precisa mostrá-lo.',
    false: 'É pergunta, opinião, agradecimento, pedido de status ou conversa; o quadro não muda.'
  },
  close: {
    true: 'Algum cartão precisa ser concluído, criado ou corrigido para o quadro refletir o que aconteceu.',
    false: 'Turno de conversa, sem trabalho nenhum: o quadro já reflete tudo.'
  }
} as const

function clamp(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** O status do cartão no mesmo rótulo que o digest do PO usa; o que não for um
 *  dos três conhecidos passa como veio. */
function statusLabel(status: string): string {
  if (status === 'completed') return 'concluída'
  if (status === 'in_progress') return 'em andamento'
  if (status === 'pending') return 'a fazer'
  return status
}

/**
 * O `state` da pergunta.
 *
 * Todos os campos são obrigatórios (vazios quando não há valor) e JSON puro,
 * rotulados com os mesmos nomes que as perguntas citam (QUADRO, AÇÕES DO TURNO,
 * TAREFAS DO REGISTRO) — é o que deixa o Jev ligar a pergunta ao campo certo.
 */
export type BoardGateState = {
  pedido_do_usuario: string
  quadro: string[]
  quadro_omitidos: number
  acoes_do_turno: string[]
  acoes_omitidas: number
  tarefas_do_registro: string[]
  tarefas_omitidas: number
}

export function buildBoardGateState(input: BoardGateInput): BoardGateState {
  const cards = (input.cards ?? []).slice(0, BOARD_GATE_MAX_CARDS)
  // As ÚLTIMAS ações, não as primeiras: a evidência do que terminou está no fim
  // do turno — mesmo critério do acúmulo de ações do PO.
  const allCalls = input.calls ?? []
  const calls = allCalls.slice(-BOARD_GATE_MAX_CALLS)
  const tasks = (input.ledgerTasks ?? []).slice(0, BOARD_GATE_MAX_TASKS)
  return {
    pedido_do_usuario: clamp(input.userText, BOARD_GATE_MAX_USER_CHARS) || '(sem texto)',
    quadro: cards.map((card) => clamp(`[${statusLabel(card.status)}] ${card.title}`, BOARD_GATE_MAX_CARD_CHARS)),
    quadro_omitidos: Math.max(0, (input.cards ?? []).length - cards.length),
    acoes_do_turno: calls.map((call) => clamp(`${call.tool}: ${call.detail}`, BOARD_GATE_MAX_CALL_CHARS)),
    acoes_omitidas: Math.max(0, allCalls.length - calls.length),
    tarefas_do_registro: tasks.map((task) => clamp(`[${task.status}] ${task.title}`, BOARD_GATE_MAX_TASK_CHARS)),
    tarefas_omitidas: Math.max(0, (input.ledgerTasks ?? []).length - tasks.length)
  }
}

/**
 * O gate está de pé nesta máquina? Só com o recurso ligado E com chave.
 *
 * Existe para o PO não montar o `state` antes de descobrir que não há a quem
 * perguntar. Nunca lança.
 */
export async function boardGateActive(): Promise<boolean> {
  try {
    if (!typeSafeEnabled()) return false
    return (await typeSafeApiKey()) !== null
  } catch {
    return false
  }
}

/**
 * O veredito: `true` rodar o PO, `false` não gastar o modelo, `null` SEM decisão.
 *
 * O mesmo corte do gate de memória: `noul` é P(sim), não confiança, então o
 * teste é `noul >= typeSafeMinConfidence()`. Um `noul` baixíssimo é um "não"
 * fortíssimo, nunca uma resposta incerta.
 *
 * Nunca lança.
 */
export async function shouldRunPo(
  input: BoardGateInput,
  options: AskTypeSafeOptions = {}
): Promise<boolean | null> {
  try {
    const phase = input.phase === 'open' ? 'open' : 'close'
    const question = phase === 'open' ? BOARD_GATE_OPEN_QUESTION : BOARD_GATE_CLOSE_QUESTION
    const answers = await askTypeSafe(
      {
        state: buildBoardGateState(input),
        questions: { rodar: noul(question, BOARD_GATE_CRITERIA[phase]) }
      },
      options
    )
    if (!answers) return null
    const yes = answers.rodar.noul
    if (typeof yes !== 'number' || !Number.isFinite(yes)) return null
    return yes >= typeSafeMinConfidence()
  } catch (error) {
    // Só a mensagem, nunca o `state` — ele carrega o pedido do usuário e os
    // alvos das ações da conversa.
    console.error(`[typesafe] gate do quadro descartado: ${(error as Error)?.message ?? error}`)
    return null
  }
}
