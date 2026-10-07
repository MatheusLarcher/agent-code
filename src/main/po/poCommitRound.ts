import { boardItemStatus, boardItemTitle, type BoardItem } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { formatPoGitEvidence, type PoGitEvidence } from './poGit'
import { clamp, PO_MAX_TITLE_CHARS } from './poPrompt'
import { PO_MAX_OPS } from './poPromptText'
import type { PoObserverRequest } from './poProviders'
import { parsePoVerdict } from './poVerdict'

/**
 * A rodada do PO disparada pelo VIGIA DO GIT (poCommitWatch.ts): o repositório
 * ganhou commit fora do chat (o usuário commitou no terminal, na IDE) e há
 * cartão de pendência "a fazer" no projeto. A pergunta é uma só — quais
 * pendências os commits novos resolveram — e a resposta só pode CONCLUIR:
 * qualquer outra operação do veredito é descartada aqui, pelo código. O vigia
 * nunca cria, renomeia, justifica nem reabre cartão.
 *
 * O que não deixa rastro no git (um deploy feito à mão) não se resolve aqui:
 * só quando o usuário conta no chat, e aí a abertura do PO resolve.
 */

/** Pendências por rodada: o prompt não cresce com o quadro. */
export const PO_COMMIT_MAX_PENDENCIES = 10

export const PO_SYSTEM_PROMPT_COMMIT = `Você é o PO (product owner) de um quadro de tarefas.

O repositório do projeto ganhou commit novo FORA do chat — o usuário commitou no terminal ou na
IDE. No quadro há cartões de PENDÊNCIA "a fazer": passos que sobraram de pedidos já entregues
(commitar, verificar no app, deploy). Seu trabalho é um só: dizer quais dessas pendências os
commits novos resolveram.

Responda com uma operação por linha, no formato exato:

CONCLUIR <id> | <motivo curto, citando o commit>

Se nenhuma pendência foi resolvida pelos commits, responda exatamente OK. Na dúvida, responda OK.

Regras inegociáveis:
- Só CONCLUIR, e só para os ids da seção PENDÊNCIAS ABERTAS. Qualquer outra operação é descartada.
- Conclua só com evidência no GIT DA PASTA: uma pendência de commit ("Commitar a fase 1 do
  escritório") com um commit novo que fala do mesmo trabalho foi resolvida; se o status ainda
  mostra arquivos daquele trabalho sem commit, o commit pode ter sido só de parte — na dúvida, OK.
- Pendência que o git não mostra (deploy, verificar no app rodando, publicar) NÃO se resolve por
  commit: deixe-a como está.
- No máximo ${PO_MAX_OPS} operações. Sem texto fora das linhas de operação.`

export function buildPoCommitPrompt(pendencies: readonly BoardItem[], parents: ReadonlyMap<string, BoardItem>, git: PoGitEvidence): string {
  const lines = pendencies.slice(0, PO_COMMIT_MAX_PENDENCIES).map((card) => {
    const parent = card.parentId ? parents.get(card.parentId) : undefined
    const origin = parent ? ` (pendência de: ${clamp(boardItemTitle(parent), PO_MAX_TITLE_CHARS)})` : ''
    return `- ${card.id} [a fazer] ${clamp(boardItemTitle(card), PO_MAX_TITLE_CHARS)}${origin}`
  })
  return `${PO_SYSTEM_PROMPT_COMMIT}\n\n---\n\nPENDÊNCIAS ABERTAS:\n${lines.join('\n')}\n\n${formatPoGitEvidence(git)}`
}

/** Pendência aberta: vinculada a um pedido, "a fazer" e no quadro. */
export function isOpenPendency(card: BoardItem): boolean {
  return Boolean(card.parentId) && card.dismissedAt === null && boardItemStatus(card) === 'pending'
}

/** O veredito reduzido ao que o vigia pode escrever: CONCLUIR em pendência aberta. */
export function commitVerdictOps(raw: string, pendencies: readonly BoardItem[]): { id: string; reason: string }[] {
  const ids = pendencies.map((card) => card.id)
  return parsePoVerdict(raw, ids, 'close').flatMap((op) => (op.kind === 'complete' ? [{ id: op.id, reason: op.reason }] : []))
}

export interface PoCommitRoundDeps {
  board: Pick<BoardService, 'list' | 'applyPo'>
  /** A consulta ao modelo (Claude, com a Luna de reserva); `null` = sem veredito. */
  consult(request: PoObserverRequest): Promise<string | null>
  model(): string
  newCorrelationId?(): string
}

export interface PoCommitRoundInput {
  cwd: string
  projectId: string
  git: PoGitEvidence
}

/** Uma rodada. Devolve os ids concluídos. Nunca lança: o vigia não pode cair. */
export async function runPoCommitRound(deps: PoCommitRoundDeps, input: PoCommitRoundInput): Promise<string[]> {
  try {
    const cards = (await deps.board.list(input.cwd)) ?? []
    const pendencies = cards.filter(isOpenPendency).slice(0, PO_COMMIT_MAX_PENDENCIES)
    if (pendencies.length === 0) return []
    const parents = new Map(cards.map((card) => [card.id, card]))
    const request: PoObserverRequest = Object.freeze({
      prompt: buildPoCommitPrompt(pendencies, parents, input.git),
      model: deps.model(),
      conversationId: pendencies[0].conversationId,
      cwd: input.cwd,
      projectId: input.projectId,
      phase: 'close' as const,
      cards: Object.freeze(pendencies.map((card) => Object.freeze({ ...card }))),
      correlationId: deps.newCorrelationId?.() ?? `po-commit-${Date.now().toString(36)}`
    })
    const text = await deps.consult(request)
    if (text === null) return []
    const done: string[] = []
    for (const op of commitVerdictOps(text, pendencies)) {
      // Condicional: o usuário (ou outra rodada) pode ter mexido no cartão
      // durante a consulta — só conclui o que continua pendência aberta.
      const written = await deps.board.applyPo({
        id: op.id,
        poStatus: 'completed',
        poReason: op.reason,
        onlyIf: (current) => isOpenPendency(current)
      })
      if (written && boardItemStatus(written) === 'completed') done.push(op.id)
    }
    return done
  } catch {
    return []
  }
}
