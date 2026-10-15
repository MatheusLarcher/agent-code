/**
 * O TEXTO do turno como o PO o recebe: a mensagem do usuário, as mensagens do
 * agente durante o turno e a resposta final — inteiras, catalogadas.
 *
 * Antes o digest levava 1.200 caracteres do pedido e 1.000 da última resposta
 * (as duas pontas, com "…" no meio). O PO decidia CONCLUIR/PENDENTE por um
 * recorte: a frase "falta X" no meio de uma resposta longa sumia, e o cartão
 * era concluído com trabalho faltando. Agora o texto vai inteiro; o único corte
 * é um teto de SEGURANÇA por seção (`PO_MAX_SECTION_CHARS`), alto de propósito,
 * que só existe para um turno patológico não virar um prompt sem fim — e que
 * nunca toca a resposta final, que é o que decide o cartão do pedido.
 *
 * Este arquivo NÃO importa nada do PO: poPrompt.ts e poQueue.ts importam daqui,
 * e um ciclo faria a constante chegar `undefined` em quem carrega primeiro.
 */

/** O teto de segurança de UMA seção de texto do turno (a mensagem do usuário,
 *  as mensagens intermediárias do agente). ~15k tokens em português: um turno
 *  normal fica muito abaixo, e o corte, quando acontece, avisa quanto omitiu. */
export const PO_MAX_SECTION_CHARS = 60_000

/** O aviso que fica no lugar do que o corte tirou. */
export function omittedNote(count: number): string {
  return `[… ${count} caracteres omitidos]`
}

/**
 * Corta pelo MEIO, guardando as duas pontas, quando o texto passa de `max` —
 * com o aviso de quantos caracteres saíram. O início diz do que o texto trata;
 * o fim, onde ele chegou. O resultado nunca passa de `max`.
 */
export function cutMiddle(text: string, max: number): string {
  const clean = (text ?? '').trim()
  if (clean.length <= max) return clean
  // O aviso é dimensionado primeiro pelo PIOR número (o texto inteiro); os
  // dígitos que o número real não usa voltam para o texto. Diminuir o omitido
  // nunca aumenta o aviso, então a conta nunca passa de `max`.
  const worst = omittedNote(clean.length).length
  let keep = Math.max(0, max - worst - 2)
  keep += worst - omittedNote(clean.length - keep).length
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${clean.slice(0, head)}\n${omittedNote(clean.length - keep)}\n${tail > 0 ? clean.slice(-tail) : ''}`
}

/** O texto de UM turno do agente principal: as mensagens que ele escreveu antes
 *  da resposta final (em ordem) e a resposta final. Sem pensamento, sem
 *  subagente e sem saída de ferramenta — quem filtra é `observe` (po.ts), que só
 *  recebe o `assistant-text` final do agente principal. */
export interface PoTurnLog {
  messages: readonly string[]
  reply: string | null
}

/**
 * Separa o que o agente escreveu num turno em intermediárias e resposta final.
 * A final é o texto do `result` quando houver (é o que o SDK diz que encerrou o
 * turno) e, sem ele, o último texto do turno. O último texto que É a final não
 * se repete nas intermediárias.
 */
export function splitTurnText(texts: readonly string[], resultText?: string | null): PoTurnLog {
  const clean = texts.map((text) => text.trim()).filter(Boolean)
  const reply = resultText?.trim() || clean.at(-1) || null
  const messages = reply !== null && clean.at(-1) === reply ? clean.slice(0, -1) : clean
  return { messages, reply }
}

/** Um log sem nada escrito (o turno sintético do flush e da retentativa) não é
 *  turno nenhum: não entra na fila nem ganha rótulo. */
export function isEmptyLog(log: PoTurnLog | null | undefined): boolean {
  return !log || (log.messages.length === 0 && !log.reply)
}

/** O tamanho de um log na conta do teto de memória da fila. */
export function logSize(log: PoTurnLog): number {
  return log.messages.reduce((sum, text) => sum + text.length, 0) + (log.reply?.length ?? 0)
}

function numbered(messages: readonly string[]): string[] {
  return messages.map((text, index) => `[mensagem ${index + 1}]\n${text}`)
}

/**
 * O corpo da seção de mensagens intermediárias. Com turnos adiados pelo cooldown
 * (`earlier`, do mais antigo para o mais novo), cada um vem com o próprio rótulo
 * e a resposta final DAQUELE turno, e o turno atual fecha a lista; sem eles, só
 * as mensagens numeradas. Vazio quando não há nada a mostrar — a seção some.
 * Passando do teto, corta do meio (`cutMiddle`).
 */
export function formatTurnMessages(earlier: readonly PoTurnLog[], messages: readonly string[]): string {
  const past = earlier.filter((log) => !isEmptyLog(log))
  if (past.length === 0) return cutMiddle(numbered(messages).join('\n\n'), PO_MAX_SECTION_CHARS)
  const blocks = past.map((log, index) => {
    const lines = [`[turno anterior ${index + 1} de ${past.length}, adiado pelo cooldown]`, ...numbered(log.messages)]
    if (log.reply) lines.push(`[resposta final daquele turno]\n${log.reply}`)
    return lines.join('\n\n')
  })
  const current = messages.length > 0 ? numbered(messages) : ['(nenhuma mensagem antes da resposta final)']
  blocks.push(['[este turno]', ...current].join('\n\n'))
  return cutMiddle(blocks.join('\n\n'), PO_MAX_SECTION_CHARS)
}
