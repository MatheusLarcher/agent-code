import {
  SCRUM_LINE_COBRANCA,
  SCRUM_LINE_DESVIO,
  SCRUM_LINE_JUSTIFICADO,
  SCRUM_LINE_PARAR
} from './scrumPromptText'
import { SCRUM_DESVIOS, type ScrumGatilho, type ScrumTipoDesvio, type ScrumVeredito } from './scrumTypes'

/**
 * Lê a resposta do modelo do SM: as linhas fixas do veredito e da cobrança
 * (o formato está em SCRUM_SYSTEM_PROMPT). Linha fora do formato é ignorada; a
 * primeira linha de veredito vale e a primeira COBRANCA também.
 *
 * Sem veredito = `falha`: quem chama manda o texto fixo e nunca corta nem para.
 * PARAR fora do marco de 300% e do travado é lido como DESVIO.
 */

const MAX_MOTIVO = 500
const MAX_COBRANCA = 1_000

/** Tira enfeite de markdown do começo da linha (lista, citação, negrito, crase). */
function clean(line: string): string {
  return line.trim().replace(/^[\s>*`_#-]+/, '').replace(/[*`_]+(?=\s*\|)/, '')
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function keyword(line: string): { key: string; rest: string[] } | null {
  const parts = clean(line).split('|')
  if (parts.length < 2) return null
  const key = parts[0].trim().toUpperCase().replace('Ç', 'C')
  return { key, rest: parts.slice(1).map((p) => p.trim()) }
}

function isDesvio(word: string): word is ScrumTipoDesvio {
  return (SCRUM_DESVIOS as readonly string[]).includes(word)
}

/** O gatilho em que PARAR vale como PARAR. */
export function scrumGatilhoPodeParar(gatilho: ScrumGatilho): boolean {
  return gatilho === 300 || gatilho === 'travado'
}

export function parseScrumVerdict(text: string, gatilho: ScrumGatilho): ScrumVeredito {
  let veredito: ScrumVeredito | null = null
  let cobranca: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const k = keyword(line)
    if (!k) continue
    if (k.key === SCRUM_LINE_COBRANCA) {
      const body = cut(k.rest.join(' | '), MAX_COBRANCA)
      if (cobranca === null && body) cobranca = body
      continue
    }
    if (veredito) continue
    if (k.key === SCRUM_LINE_JUSTIFICADO) {
      veredito = { veredito: 'justificado', tipoDesvio: null, motivo: cut(k.rest.join(' | '), MAX_MOTIVO), cobranca: null }
    } else if (k.key === SCRUM_LINE_DESVIO) {
      const tipo = (k.rest[0] ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      const known = isDesvio(tipo)
      const motivo = (known ? k.rest.slice(1) : k.rest).join(' | ')
      veredito = { veredito: 'desvio', tipoDesvio: known ? tipo : null, motivo: cut(motivo, MAX_MOTIVO), cobranca: null }
    } else if (k.key === SCRUM_LINE_PARAR) {
      const motivo = cut(k.rest.join(' | '), MAX_MOTIVO)
      veredito = scrumGatilhoPodeParar(gatilho)
        ? { veredito: 'parar', tipoDesvio: null, motivo, cobranca: null }
        : { veredito: 'desvio', tipoDesvio: null, motivo, cobranca: null }
    }
  }
  if (!veredito) return { veredito: 'falha', tipoDesvio: null, motivo: 'o modelo não respondeu com um veredito', cobranca }
  return { ...veredito, cobranca }
}
