/**
 * Turn the Markdown of an assistant answer into a clean string for text-to-speech.
 *
 * The spoken text is NOT a literal read of the source — it's a treated copy, so the
 * voice doesn't read things that make no sense out loud:
 *  - fenced code blocks (``` … ```) are dropped — example code isn't read;
 *  - tables are NOT read; each table is replaced by a short mention ("conforme a
 *    tabela") so the listener knows one is there;
 *  - links/URLs: `[text](url)` keeps only `text`; bare URLs are dropped;
 *  - images `![alt](url)` are dropped;
 *  - emphasis/heading/quote/list markers are stripped, keeping the words.
 *
 * Pure function (no DOM), so it runs anywhere and is easy to unit-test.
 */
export function toSpeechText(markdown: string): string {
  if (!markdown) return ''
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  let inFence = false

  const isTableDelim = (s: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(s)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code blocks: drop everything between the fences (and the fences).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // GFM table: a row with pipes followed by a delimiter row. Replace the whole
    // contiguous table with a single mention so it's cited but not read out.
    if (/\|/.test(line) && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      while (i < lines.length && /\|/.test(lines[i])) i++
      i-- // the for-loop will ++ back to the first non-table line
      out.push('conforme a tabela.')
      continue
    }

    out.push(cleanInline(line))
  }

  // Collapse blank runs and trim.
  return out
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s*\.\s*\.\s*/g, '. ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/**
 * Split already-treated speech text into chunks the caller synthesizes and plays
 * in sequence, so playback starts after just the FIRST chunk — not the whole
 * answer. Chunk sizes RAMP UP: the first is tiny (≈ one short sentence) so the
 * first audio comes back fast, later ones are bigger to keep the number of TTS
 * calls low. Over-long sentences are broken on clause/word boundaries so no
 * single chunk (especially the first) is huge.
 */
const CHUNK_RAMP = [60, 150, 260] // char budget for chunk 0, 1, 2+
const HARD_MAX = 260

export function splitForSpeech(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Break any sentence longer than the hard cap so the first chunk can stay small.
  const parts: string[] = []
  for (const s of sentences) {
    if (s.length <= HARD_MAX) parts.push(s)
    else parts.push(...breakLong(s, HARD_MAX))
  }

  const chunks: string[] = []
  let cur = ''
  const limit = (): number => CHUNK_RAMP[Math.min(chunks.length, CHUNK_RAMP.length - 1)]
  for (const p of parts) {
    if (cur && cur.length + 1 + p.length > limit()) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${p}` : p
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** Break a too-long sentence into ≤max pieces, preferring clause boundaries
 *  (commas/semicolons/colons/dashes), falling back to word splits. */
function breakLong(sentence: string, max: number): string[] {
  const out: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const clause of sentence.split(/(?<=[,;:—])\s+/)) {
    if (clause.length > max) {
      push()
      let w = ''
      for (const word of clause.split(/\s+/)) {
        if (w && w.length + 1 + word.length > max) {
          out.push(w)
          w = ''
        }
        w = w ? `${w} ${word}` : word
      }
      if (w) cur = w
    } else {
      if (cur && cur.length + 1 + clause.length > max) push()
      cur = cur ? `${cur} ${clause}` : clause
    }
  }
  push()
  return out
}

/** Strip inline Markdown from a single line, keeping the spoken words. */
function cleanInline(line: string): string {
  let s = line

  // Images first (so their alt/url don't leak), then links → keep the label.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Bare URLs (http(s):// or www.) — don't read them.
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, '')
  s = s.replace(/\bwww\.[^\s)]+/gi, '')

  // Inline code: keep the inner text (often a name/word), drop the backticks.
  s = s.replace(/`([^`]*)`/g, '$1')

  // Headings / blockquotes / list markers at the start of the line.
  s = s.replace(/^\s{0,3}#{1,6}\s+/, '')
  s = s.replace(/^\s*>\s?/, '')
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/, '')

  // Emphasis markers (bold/italic/strike) — keep the words.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(\*|_)(.*?)\1/g, '$2')
  s = s.replace(/~~(.*?)~~/g, '$1')

  // Leftover stray markdown punctuation.
  s = s.replace(/[*_`>#]/g, '')

  return s
}
