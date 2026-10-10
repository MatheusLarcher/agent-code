/**
 * A parte de TEXTO do vocabulário de reforço do ditado, sem dependência de
 * Node: o PC (src/main/voice/hotwords.ts) e o celular (src/phone/voice/localStt.ts)
 * usam a mesma lista e a mesma correção — "git hub" → "GitHub", "back end" →
 * "backend", "typescript" → "TypeScript": a grafia da lista vence.
 */

/** Juntar palavras separadas ("no de" → "Node") só para termos com 5+ letras. */
const MIN_MERGE_CHARS = 5

/** Um termo por linha; `#` comenta; repetidos saem. */
export function parseVocabulary(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const term = raw.replace(/#.*/, '').trim().replace(/\s+/g, ' ')
    if (!term || seen.has(term)) continue
    seen.add(term)
    out.push(term)
  }
  return out
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s.\-]+/g, '')
const WORD = /[\p{L}\p{N}]+(?:[.\-][\p{L}\p{N}]+)*/gu
const MAX_SPAN = 3

/** Troca no texto as formas quebradas ou com outra caixa pela grafia da lista. */
export function fixWithVocabulary(text: string, terms: readonly string[]): string {
  const byKey = new Map<string, string>()
  for (const term of terms) if (!byKey.has(squash(term))) byKey.set(squash(term), term)
  const words = [...text.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }))
  let out = ''
  let pos = 0
  for (let i = 0; i < words.length; ) {
    let done = false
    for (let n = Math.min(MAX_SPAN, words.length - i); n >= 1 && !done; n--) {
      const span = words.slice(i, i + n)
      if (span.some((w, k) => k > 0 && !/^[\s-]+$/.test(text.slice(span[k - 1].end, w.start)))) continue
      const term = byKey.get(squash(span.map((w) => w.text).join('')))
      if (!term) continue
      const termWords = term.split(' ').length
      // Juntar palavras soltas só com pedaços de 2+ letras e termo longo o bastante.
      if (n > termWords && (span.some((w) => w.text.length < 2) || squash(term).length < MIN_MERGE_CHARS)) continue
      const original = text.slice(span[0].start, span[n - 1].end)
      // Termo em minúscula: maiúscula só no começo da frase ("Build" no meio vira "build").
      const before = text.slice(0, span[0].start)
      const sentenceStart = !before.trim() || /[.!?…]\s*$/.test(before)
      const replacement =
        term === term.toLowerCase() && sentenceStart && /^\p{Lu}/u.test(original) ? term[0].toUpperCase() + term.slice(1) : term
      if (replacement === original) continue
      out += text.slice(pos, span[0].start) + replacement
      pos = span[n - 1].end
      i += n
      done = true
    }
    if (!done) i++
  }
  return out + text.slice(pos)
}
