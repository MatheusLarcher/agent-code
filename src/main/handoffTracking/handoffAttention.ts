/**
 * O aviso em tempo real da conversa de handoff: a linha do texto do assistente
 * que COMEÇA com "ATENÇÃO:" ou "DESVIO DO PLANO:" vira `handoff-aviso` (toast no
 * app e no celular). Só prefixo no início da linha — sem LLM, sem regex solta no
 * meio do texto: a citação "…ele disse ATENÇÃO: x" não dispara. Marcadores de
 * markdown na frente (lista, citação, negrito) não contam como texto.
 */

const PREFIX = /^(?:ATENÇÃO|DESVIO DO PLANO):/u
const LEADING_MARKUP = /^\s*(?:(?:[-*+>]|\d+[.)])\s+)*(?:\*\*|__)?/u

export function attentionLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r/gu, '').split('\n')) {
    const line = raw.replace(LEADING_MARKUP, '')
    if (!PREFIX.test(line)) continue
    const clean = line.replace(/^(ATENÇÃO|DESVIO DO PLANO):(?:\*\*|__)?/u, '$1:').trim()
    if (clean.length > 'ATENÇÃO:'.length) out.push(clean)
  }
  return out
}
