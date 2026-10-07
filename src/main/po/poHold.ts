import { clamp } from './poPrompt'

/**
 * O PO SEGURA A FILA quando o próximo prompt ficou velho: no fechamento, o
 * digest recebe o RESUMO do próximo envio da fila (título e etapas, nunca o
 * texto inteiro), e a operação `SEGURAR | <motivo>` vem no MESMO veredito — sem
 * chamada extra. Só quando a resposta do agente contradiz uma premissa
 * explícita do próximo prompt; na dúvida, o PO não segura.
 *
 * Falha aberta: sem veredito (falha, cooldown, PO desligado) nada é segurado e
 * a regra fixa da fila decide sozinha.
 */

/** O próximo prompt que o fechamento leva ao PO: o id (para segurar o certo) e o resumo. */
export interface PoNextPrompt {
  envioId: string
  /** "Prompt 3 de 4 (2026-10-06-03.md) — etapas: [x] Título, [y] Título". */
  summary: string
}

const HOLD_LINE = /^[`\s>*-]*SEGURAR[\s*`_]*\|\s*(.+?)[\s*`_]*$/i
export const PO_HOLD_REASON_CHARS = 200

/** A seção do digest do fechamento (só existe com um próximo prompt na fila). */
export function formatPoNextPrompt(next: PoNextPrompt): string {
  return [
    'PRÓXIMO PROMPT DA FILA (sai depois deste turno; só o resumo):',
    `  ${next.summary}`,
    'Se a resposta do agente neste turno CONTRADIZ uma premissa explícita desse próximo prompt (ex.: o agente já fez o que ele manda fazer, ou mudou algo de que ele depende), acrescente a linha:',
    'SEGURAR | <o motivo, em uma frase>',
    'Na dúvida, não segure: a fila segue sozinha.'
  ].join('\n')
}

/** O motivo do SEGURAR (a última linha válida); sem motivo, a linha não vale. */
export function parsePoHold(raw: string): string | null {
  const lines = (raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = HOLD_LINE.exec(lines[i])
    if (match && match[1].trim()) return clamp(match[1], PO_HOLD_REASON_CHARS)
  }
  return null
}
