/**
 * Brazilian Portuguese phonemes for Kokoro.
 *
 * kokoro-js only phonemizes English (its `phonemizer` dependency is en-only), so
 * we run the full eSpeak NG (WASM build from @echogarden) with the `pt-br`
 * voice and reshape its IPA into Kokoro's vocabulary:
 *   - eSpeak separates phonemes with `_`, words with ` ` and clauses with ` | `;
 *   - Kokoro (misaki) writes affricates and diphthongs as single symbols
 *     (tʃ→ʧ, dʒ→ʤ, ts→ʦ, dz→ʣ, eɪ→A, aɪ→I, aʊ→W, oʊ→O, ɔɪ→Y). The stress
 *     mark (ˈ/ˌ) is set aside while looking the phoneme up, then put back;
 *   - eSpeak drops punctuation, so the text is split on punctuation first and
 *     the marks are re-inserted between the phonemized pieces (Kokoro uses them
 *     for pauses and intonation).
 */

export const KOKORO_TIES: Readonly<Record<string, string>> = {
  'tʃ': 'ʧ',
  'dʒ': 'ʤ',
  ts: 'ʦ',
  dz: 'ʣ',
  'eɪ': 'A',
  'aɪ': 'I',
  'aʊ': 'W',
  'oʊ': 'O',
  'ɔɪ': 'Y'
}

/** A run of punctuation with its surrounding spaces. */
export const PUNCTUATION_RUN = /(\s*[;:,.!?¡¿—…"«»“”()]+\s*)+/g

/** Map one eSpeak phoneme (possibly stress-prefixed) to Kokoro's symbol. */
export function mapPhoneme(p: string): string {
  const stress = /^[ˈˌ]*/.exec(p)?.[0] ?? ''
  const bare = p.slice(stress.length)
  return stress + (KOKORO_TIES[bare] ?? bare)
}

/** Reshape raw `convert_to_phonemes` output into a Kokoro phoneme string. */
export function espeakToKokoro(raw: string): string {
  return raw
    .split('|')
    .map((clause) =>
      clause
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.split('_').filter(Boolean).map(mapPhoneme).join(''))
        .filter(Boolean)
        .join(' ')
    )
    .filter(Boolean)
    .join(' ')
}

/**
 * Phonemize `text`, keeping punctuation. `convert` returns eSpeak's raw
 * phoneme output for a punctuation-free piece of text.
 */
export function phonemizeWith(text: string, convert: (piece: string) => string): string {
  let out = ''
  let last = 0
  const piece = (s: string): void => {
    if (/[\p{L}\p{N}]/u.test(s)) out += espeakToKokoro(convert(s.trim()))
  }
  for (const m of text.matchAll(PUNCTUATION_RUN)) {
    const at = m.index ?? 0
    if (at > last) piece(text.slice(last, at))
    out += m[0]
    last = at + m[0].length
  }
  if (last < text.length) piece(text.slice(last))
  return out.replace(/\s+/g, ' ').trim()
}

interface EspeakModule {
  HEAPU8: Uint8Array
  eSpeakNGWorker: new () => {
    set_voice(name: string): unknown
    convert_to_phonemes(text: string, ipa: boolean): { ptr: number } | number
  }
}

let espeak: Promise<(piece: string) => string> | null = null

/** Load eSpeak NG (≈24 MB of voice data, read from node_modules) once. */
export function loadEspeakPtBr(): Promise<(piece: string) => string> {
  espeak ??= (async () => {
    const { default: createModule } = (await import('@echogarden/espeak-ng-emscripten')) as {
      default: () => Promise<EspeakModule>
    }
    const m = await createModule()
    const worker = new m.eSpeakNGWorker()
    worker.set_voice('pt-br')
    const decoder = new TextDecoder()
    return (piece: string): string => {
      const res = worker.convert_to_phonemes(piece, true)
      const ptr = typeof res === 'number' ? res : res.ptr
      let end = ptr
      while (m.HEAPU8[end]) end++
      return decoder.decode(m.HEAPU8.subarray(ptr, end))
    }
  })()
  espeak.catch(() => {
    espeak = null
  })
  return espeak
}

/** Phonemize pt-BR text for Kokoro with the real eSpeak NG. */
export async function phonemizePtBr(text: string): Promise<string> {
  const convert = await loadEspeakPtBr()
  return phonemizeWith(text, convert)
}
