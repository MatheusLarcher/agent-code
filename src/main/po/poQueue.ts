import { PO_MAX_CALLS, PO_MAX_USER_CHARS, type PoCall } from './poPrompt'

/**
 * A fila dos turnos que o cooldown adiou — funções PURAS: recebem a fila e o
 * turno e devolvem a fila nova, sem tocar em nada do que receberam. Quem guarda
 * a fila (uma por fase, por conversa) é `Po`; aqui só vivem as regras de como
 * ela cresce, é consumida e é devolvida, com os mesmos tetos do digest.
 */

/** A fila dos turnos que ainda não passaram pelo PO. */
export interface PoDeferred {
  texts: string[]
  calls: PoCall[]
}

/** Evidence captured synchronously with a result, before board ingestion yields. */
export interface PoTurnSnapshot {
  userText: string
  cwd: string
  calls: readonly PoCall[]
}

/** Vários pedidos num digest só, numerados: sem a numeração o modelo lê a
 *  emenda como um pedido único e responde por um só. */
export function joinRequests(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? ''
  return texts.map((text, index) => `(${index + 1}) ${text}`).join(' ')
}

/** Aplica os tetos do digest a uma fila montada do zero (os arrays recebidos
 *  já são cópias): descarta do mais ANTIGO, que é quem está na frente. */
function capped(texts: string[], calls: PoCall[]): PoDeferred {
  while (texts.length > 1 && texts.join(' ').length > PO_MAX_USER_CHARS) texts.shift()
  if (calls.length > PO_MAX_CALLS) calls.splice(0, calls.length - PO_MAX_CALLS)
  return { texts, calls }
}

/** Guarda o turno que o cooldown pulou, na fila DESSA fase — com os mesmos
 *  tetos do digest, para o acumulado não crescer com o número de turnos
 *  pulados. */
export function defer(queue: PoDeferred | null, turn: PoTurnSnapshot): PoDeferred {
  return capped([...(queue?.texts ?? []), turn.userText], [...(queue?.calls ?? []), ...turn.calls])
}

/**
 * Junta os turnos pulados ao turno de agora, DENTRO do orçamento do digest.
 *
 * O teto tem que ser aplicado aqui, e descartando do mais ANTIGO para o mais
 * novo: o `clamp` do digest corta pela cauda, então entregar tudo concatenado
 * faria o acumulado cheio empurrar para fora justamente o pedido que acabou
 * de chegar — o oposto do que este acúmulo existe para fazer. O pedido de
 * AGORA entra sempre, mesmo quando sozinho já estoura o teto (aí ele é
 * truncado, mas continua sendo ele). Nas ações vale o mesmo critério: as
 * mais recentes sobrevivem, porque a evidência do fim é a que decide o que
 * terminou.
 */
export function mergeDeferred(deferred: PoDeferred | null, turn: PoTurnSnapshot): PoTurnSnapshot {
  if (!deferred || (deferred.texts.length === 0 && deferred.calls.length === 0)) return turn
  const kept = [...deferred.texts, turn.userText].filter((text) => text.trim().length > 0)
  while (kept.length > 1 && joinRequests(kept).length > PO_MAX_USER_CHARS) kept.shift()
  return Object.freeze({
    userText: joinRequests(kept) || turn.userText,
    cwd: turn.cwd,
    calls: Object.freeze([...deferred.calls, ...turn.calls].slice(-PO_MAX_CALLS))
  })
}

/**
 * Devolve à fila o acumulado que esta análise pegou e não chegou a auditar.
 *
 * Sem isso, uma falha depois da retirada (Claude indisponível, Luna sem
 * configuração, quadro rejeitando a escrita) apaga para sempre turnos que
 * NUNCA passaram pelo PO — exatamente o buraco que o acúmulo tapa. Tirar da
 * fila é um empréstimo até a análise terminar, não uma baixa.
 *
 * Sem nada a devolver, a fila volta como estava (inclusive `null`).
 */
export function restoreDeferred(queue: PoDeferred | null, taken: PoDeferred): PoDeferred | null {
  if (taken.texts.length === 0 && taken.calls.length === 0) return queue
  // O que volta é mais ANTIGO do que o que entrou na fila enquanto a análise
  // rodava, então volta na frente — e os mesmos tetos continuam valendo.
  return capped([...taken.texts, ...(queue?.texts ?? [])], [...taken.calls, ...(queue?.calls ?? [])])
}

/** O conteúdo do próprio turno como entrada de fila. O texto vazio do turno
 *  sintético (flush do cooldown, retentativa, `dispose`) não é pedido nenhum:
 *  deixá-lo entrar acumularia uma entrada vazia a cada falha seguida. */
function ownEntry(turn: PoTurnSnapshot): PoDeferred {
  return { texts: turn.userText.trim() ? [turn.userText] : [], calls: [...turn.calls] }
}

/**
 * Devolve à fila o que uma análise que JÁ tinha retirado a fila não auditou.
 *
 * O que volta não pode ser só `taken`: ele é o acumulado de ANTES desta análise
 * começar, mas o `turn` que a disparou (o pedido e as ações que a fizeram rodar
 * agora, fora do cooldown) também nunca passou pelo PO se ela não chegar ao fim.
 * Uma versão anterior só devolvia quando havia acumulado prévio, e uma análise
 * que falhasse SEM ele (`taken` null — o caso mais comum: a primeira tentativa
 * de um turno isolado) não devolvia nada: a evidência daquele turno, inclusive a
 * tarefa que acabou de terminar, desaparecia para sempre. Juntar os dois aqui,
 * na ordem cronológica certa (o que já estava esperando primeiro, o turno de
 * agora depois), é o que faz `restoreDeferred` (que só soma ao que se acumulou
 * DURANTE a análise) devolver o turno inteiro.
 */
export function restoreTaken(queue: PoDeferred | null, taken: PoDeferred | null, turn: PoTurnSnapshot): PoDeferred | null {
  const own = ownEntry(turn)
  return restoreDeferred(queue, {
    texts: [...(taken?.texts ?? []), ...own.texts],
    calls: [...(taken?.calls ?? []), ...own.calls]
  })
}

/**
 * Devolve à fila o turno de uma análise que saiu ANTES de retirar a fila
 * (quadro indisponível, sem identidade de projeto).
 *
 * Aqui a fila nunca saiu do lugar: o acumulado antigo continua nela, e o turno
 * de agora é MAIS NOVO do que ele — vai para o FIM, exatamente onde a mescla o
 * teria posto se a análise tivesse seguido. Tratar este caso como o de
 * `restoreTaken` punha o turno de agora NA FRENTE do acumulado antigo, fora da
 * ordem cronológica — e com a retentativa este caminho deixa de ser raro.
 */
export function requeueTurn(queue: PoDeferred | null, turn: PoTurnSnapshot): PoDeferred | null {
  const own = ownEntry(turn)
  if (own.texts.length === 0 && own.calls.length === 0) return queue
  return capped([...(queue?.texts ?? []), ...own.texts], [...(queue?.calls ?? []), ...own.calls])
}
