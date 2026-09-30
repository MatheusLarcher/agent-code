/**
 * Cut text into pieces Kokoro can say in one pass.
 *
 * Kokoro's tokenizer is one token per phoneme character and the model's
 * context is 512 (510 + 2 boundary tokens); anything longer is silently
 * truncated. We split by sentence (reusing the reader's splitter, ≤260 chars
 * per piece) and, as a safety net, halve any piece whose PHONEMES still exceed
 * the budget — numbers and abbreviations can expand a lot in eSpeak.
 */
import { splitForSpeech } from '../../shared/speechText'

export const MAX_PHONEMES = 500

export async function planKokoroChunks(
  text: string,
  phonemize: (piece: string) => string | Promise<string>,
  maxPhonemes = MAX_PHONEMES
): Promise<string[]> {
  const out: string[] = []
  const push = async (piece: string): Promise<void> => {
    const words = piece.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return
    const ps = (await phonemize(words.join(' '))).trim()
    if (!ps) return
    if (ps.length <= maxPhonemes) {
      out.push(ps)
      return
    }
    if (words.length === 1) {
      out.push(ps.slice(0, maxPhonemes)) // one absurd "word": cut rather than loop
      return
    }
    const mid = Math.ceil(words.length / 2)
    await push(words.slice(0, mid).join(' '))
    await push(words.slice(mid).join(' '))
  }
  for (const piece of splitForSpeech(text)) await push(piece)
  return out
}
