/**
 * As peças do fluxo "Enviar para implementação" que não são tela: o pedido
 * fixo ao Agent Manager, o filtro dos prompts que ele gravou DEPOIS do pedido
 * e o lançamento da conversa de implementação. Puras e testáveis sem o App.
 */
import type { PlanningHandoffDto } from '@shared/ipc'

/** Folga para a resolução do relógio do sistema de arquivos (FAT: 2 s). */
export const HANDOFF_CLOCK_SLACK_MS = 2_000

/**
 * O pedido que vai para a conversa de planejamento (pelo caminho normal de
 * envio): gerar o handoff com plan_handoff_write, um ou mais prompts
 * autocontidos. Com ambiguidades abertas (o usuário escolheu enviar mesmo
 * assim), o Manager é avisado para registrar a leitura recomendada.
 *
 * `planDir` é a pasta ABSOLUTA do plano, como o main a informou (plan.dir):
 * o renderer não a monta.
 */
export function managerHandoffRequest(planDir: string, openAmbiguities = 0): string {
  const lines = [
    'Gere agora o handoff deste planejamento para a conversa de implementação.',
    '',
    'Grave com mcp__planning__plan_handoff_write UM OU MAIS prompts autocontidos — um arquivo por prompt, na ordem em que devem ser executados. ' +
      'Divida em mais de um só se o trabalho não couber numa conversa: cada prompt vai numa mensagem, e o seguinte só roda quando o anterior terminar.',
    '',
    'Cada prompt precisa trazer: o objetivo; as etapas do roteiro na ordem, com os cards de cada uma; os requisitos; as decisões com o porquê; ' +
      'as sugestões com a fonte; as ambiguidades resolvidas; riscos e critérios de aceite; e a instrução de declarar as etapas como plano ' +
      `(TodoWrite/TaskCreate) e consultar ${planDir} sem replanejar. A conversa de implementação só verá esse texto e os cards.`,
    '',
    'Não implemente nada e não altere cards nem o roteiro agora: só grave os prompts e, no fim, diga quantos gravou.'
  ]
  if (openAmbiguities > 0) {
    const n = openAmbiguities === 1 ? 'Uma ambiguidade continua aberta' : `${openAmbiguities} ambiguidades continuam abertas`
    lines.push(
      '',
      `Atenção: ${n} e o usuário decidiu enviar mesmo assim. Em cada prompt, diga qual leitura seguir (a sua recomendação) e marque-a como pendente de confirmação do usuário.`
    )
  }
  return lines.join('\n')
}

/**
 * Os prompts que surgiram em _handoff/ depois do pedido: nome que não existia
 * antes dele E criado a partir dele (com folga para o relógio do disco). Na
 * ordem em que vieram da lista (a do main, por nome).
 */
export function newHandoffsSince(
  list: readonly PlanningHandoffDto[],
  before: ReadonlySet<string>,
  requestedAt: number
): PlanningHandoffDto[] {
  return list.filter((h) => !before.has(h.name) && h.createdAt >= requestedAt - HANDOFF_CLOCK_SLACK_MS)
}

export interface HandoffLaunchDeps<C extends { id: string }> {
  /** Cria a conversa de implementação, ativa, e JÁ visível para o caminho de
   *  envio (estado e refs) — o envio logo abaixo não pode achar a conversa
   *  "inexistente" por esperar o próximo render. */
  create: () => C
  /** Caminho normal de envio. true = entregue (enviado agora ou na fila). */
  send: (conv: C, text: string) => Promise<boolean>
}

export interface HandoffLaunchResult<C> {
  conv: C | null
  /** Quantos prompts foram entregues, na ordem. */
  delivered: number
  total: number
}

/**
 * Cria a conversa e envia os prompts NA ORDEM: o 1º sai já; os seguintes, com a
 * conversa ocupada, entram na fila dela. Se um envio falha (false ou exceção),
 * os seguintes não são tentados — ficariam fora de ordem (estão gravados em
 * _handoff/). Prompt em branco é descartado; sem nenhum, nada é criado.
 */
export async function launchHandoff<C extends { id: string }>(
  prompts: readonly string[],
  deps: HandoffLaunchDeps<C>
): Promise<HandoffLaunchResult<C>> {
  const texts = prompts.filter((p) => p.trim() !== '')
  if (texts.length === 0) return { conv: null, delivered: 0, total: 0 }
  const conv = deps.create()
  let delivered = 0
  for (const text of texts) {
    // Depois de criada, a conversa existe: uma exceção no envio não pode
    // subir como "nada aconteceu" (o diálogo deixaria criar outra).
    let ok = false
    try {
      ok = await deps.send(conv, text)
    } catch {
      ok = false
    }
    if (!ok) break
    delivered++
  }
  return { conv, delivered, total: texts.length }
}

/**
 * O resultado do envio visto pelo diálogo:
 * - `sent`: conversa criada e todos os prompts entregues;
 * - `created-failed`: a conversa FOI criada, mas um envio falhou. Tentar de
 *   novo pelo diálogo criaria uma SEGUNDA conversa; o caminho é o "Tentar de
 *   novo" da mensagem que falhou, na conversa nova;
 * - `not-created`: nada foi criado (nenhum prompt com texto).
 */
export interface HandoffSendOutcome {
  status: 'sent' | 'created-failed' | 'not-created'
  delivered: number
  total: number
}

export function handoffOutcome(res: HandoffLaunchResult<unknown>): HandoffSendOutcome {
  const { delivered, total } = res
  if (!res.conv) return { status: 'not-created', delivered, total }
  return { status: delivered === total ? 'sent' : 'created-failed', delivered, total }
}

/** O toast de uma conversa criada cujo envio não terminou. */
export function handoffPartialMessage(titulo: string, outcome: HandoffSendOutcome): string {
  const rest = outcome.total - outcome.delivered - 1
  return (
    `A conversa "Implementação: ${titulo}" foi criada, mas o envio parou no prompt ${outcome.delivered + 1} de ${outcome.total}. ` +
    'Abra essa conversa e use "Tentar de novo" na mensagem que falhou' +
    (rest > 0
      ? `; ${rest === 1 ? 'o prompt seguinte está' : `os ${rest} prompts seguintes estão`} em _handoff/, para mandar depois`
      : '') +
    '. Enviar de novo por aqui criaria outra conversa.'
  )
}
