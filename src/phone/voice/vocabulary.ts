/**
 * Vocabulário de reforço do ditado no celular: a lista vem do PC no `/api/state`
 * e fica guardada no aparelho, para a transcrição local corrigir a grafia
 * ("git hub" → "GitHub") mesmo longe do PC. A correção é a mesma do PC
 * (@shared/vocabularyText); o reforço na decodificação continua só no PC.
 */
import { fixWithVocabulary } from '@shared/vocabularyText'

const KEY = 'agentRemote.voice.vocabulary'
/** Teto defensivo: a lista é curta (dezenas de termos), mas vem da rede. */
const MAX_TERMS = 2000
const MAX_TERM_CHARS = 80

let cached: string[] | null = null

function load(): string[] {
  if (cached) return cached
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
    cached = sanitize(parsed)
  } catch {
    cached = []
  }
  return cached
}

function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((term): term is string => typeof term === 'string')
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term.length <= MAX_TERM_CHARS)
    .slice(0, MAX_TERMS)
}

/** A lista que o PC mandou agora; guarda só se mudou. */
export function setVocabulary(list: unknown): void {
  const next = sanitize(list)
  const current = load()
  if (next.length === current.length && next.every((term, i) => term === current[i])) return
  cached = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* sem espaço: vale a lista em memória nesta sessão */
  }
}

export function vocabulary(): readonly string[] {
  return load()
}

/** O texto transcrito no aparelho com a grafia da lista. Sem lista, igual. */
export function applyVocabulary(text: string): string {
  const terms = load()
  return terms.length ? fixWithVocabulary(text, terms) : text
}
