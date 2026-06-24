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
