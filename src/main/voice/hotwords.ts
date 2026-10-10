/**
 * Vocabulário de reforço do ditado (contextual biasing / "hotwords"): termos que
 * o usuário fala e o Parakeet tende a errar — "backend", "GitHub", "brag"…
 * A lista (resources/voice/vocabulario.txt) vai embutida no bundle e é
 * carregada junto com o modelo. Atua em dois pontos:
 *
 *  1. Decodificação (shallow fusion num trie de tokens, à la sherpa-onnx/NeMo):
 *     cada termo vira as segmentações plausíveis em peças do vocabulário do
 *     modelo; no passo greedy, o token que começa um termo ganha START_BONUS e o
 *     que continua o termo em andamento ganha CONT_BONUS (em log-prob — somado
 *     direto ao logit, já que o softmax só desloca todos igualmente). O blank
 *     nunca ganha nada: o reforço só desempata quando o modelo já hesita.
 *  2. Texto final (fixText): "git hub" → "GitHub", "back end" → "backend",
 *     "typescript" → "TypeScript" — a grafia da lista vence.
 *
 * AGENT_CODE_VOICE_HOTWORDS=0 desliga os dois (diagnóstico).
 */
import listText from '../../../resources/voice/vocabulario.txt?raw'
import { fixWithVocabulary, parseVocabulary } from '../../shared/vocabularyText'
import { argmax, type TokenBias, type Vocab } from './tdt'

/** Calibrados no A/B com fala sintética: trocas com folga até ~1,1 corrigiam o
 *  termo; uma de 2,3 ("mocup" → "moc") desviou o resto da frase. */
const START_BONUS = 1.0
const CONT_BONUS = 1.5
/** Segmentações com até este tanto de peças além da mínima entram no trie. */
const SEGMENT_SLACK = 1
const MAX_SEGMENTATIONS = 16
/** Termos curtos demais ("PO", "UI") só passam pela correção do texto: no
 *  decodificador virariam inserções espúrias. */
const MIN_BOOST_CHARS = 3

export { fixWithVocabulary, parseVocabulary }

export const BUNDLED_VOCABULARY: readonly string[] = parseVocabulary(listText)

// ------------------------------------------------------------ decodificação

interface TrieNode {
  next: Map<number, TrieNode>
}

const newNode = (): TrieNode => ({ next: new Map() })

/** Segmentações de `s` em peças do vocabulário: as de menos peças primeiro. */
export function segmentations(s: string, pieceIds: ReadonlyMap<string, number>, maxPiece: number): number[][] {
  const n = s.length
  const best = new Array<number>(n + 1).fill(Infinity)
  best[n] = 0
  for (let i = n - 1; i >= 0; i--)
    for (let len = 1; len <= maxPiece && i + len <= n; len++)
      if (pieceIds.has(s.slice(i, i + len))) best[i] = Math.min(best[i], 1 + best[i + len])
  if (!Number.isFinite(best[0])) return []
  const budget = best[0] + SEGMENT_SLACK
  const out: number[][] = []
  const path: number[] = []
  const walk = (i: number): void => {
    if (out.length >= MAX_SEGMENTATIONS) return
    if (i === n) {
      out.push([...path])
      return
    }
    for (let len = maxPiece; len >= 1; len--) {
      if (i + len > n) continue
      const id = pieceIds.get(s.slice(i, i + len))
      if (id === undefined || path.length + 1 + best[i + len] > budget) continue
      path.push(id)
      walk(i + len)
      path.pop()
    }
  }
  walk(0)
  return out.sort((a, b) => a.length - b.length)
}

/** Grafias que o modelo pode emitir para um termo: a da lista, minúscula e Capitalizada. */
function spellings(term: string): string[] {
  const lower = term.toLowerCase()
  return [...new Set([term, lower, lower[0].toUpperCase() + lower.slice(1)])]
}

function buildTrie(vocab: Vocab, terms: readonly string[]): TrieNode {
  const pieceIds = new Map<string, number>()
  let maxPiece = 1
  vocab.pieces.forEach((piece, id) => {
    if (id === vocab.blank || /^<[^>]*>$/.test(piece.trim()) || pieceIds.has(piece)) return
    pieceIds.set(piece, id)
    maxPiece = Math.max(maxPiece, piece.length)
  })
  const root = newNode()
  for (const term of terms) {
    if (term.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_BOOST_CHARS) continue
    for (const spelling of spellings(term))
      for (const seq of segmentations(' ' + spelling, pieceIds, maxPiece)) {
        let node = root
        for (const id of seq) {
          let child = node.next.get(id)
          if (!child) node.next.set(id, (child = newNode()))
          node = child
        }
      }
  }
  return root
}

function biasSession(root: TrieNode, starts: readonly number[]): TokenBias {
  let node = root
  return {
    choose(logits, blank) {
      const top = argmax(logits)
      // Só troca uma peça por outra: QUANDO emitir continua sendo do modelo
      // (reforço contra o blank inseria letras soltas — "Buield"), e uma peça
      // que já segue um termo fica, mesmo que outra segmentação ganhe bônus.
      if (top === blank || (node !== root && node.next.has(top)) || root.next.has(top)) return top
      let best = top
      let score = logits[top]
      const consider = (ids: Iterable<number>, bonus: number): void => {
        for (const id of ids) {
          if (id === blank) continue
          const s = logits[id] + bonus
          if (s > score) {
            score = s
            best = id
          }
        }
      }
      if (node !== root) consider(node.next.keys(), CONT_BONUS)
      consider(starts, START_BONUS)
      return best
    },
    emitted(token) {
      node = node.next.get(token) ?? root.next.get(token) ?? root
    }
  }
}

// ------------------------------------------------------------ texto
// A correção do texto é compartilhada com o celular (src/shared/vocabularyText.ts).

// ------------------------------------------------------------ montagem

export interface Booster {
  /** Termos na lista. */
  terms: number
  /** Um por janela decodificada (o estado do trie é por sequência). */
  session(): TokenBias
  fixText(text: string): string
}

export function buildBooster(vocab: Vocab, terms: readonly string[] = BUNDLED_VOCABULARY): Booster | null {
  if (process.env.AGENT_CODE_VOICE_HOTWORDS === '0' || !terms.length) return null
  const root = buildTrie(vocab, terms)
  // Começo com uma letra só ("▁P" de Python) não ganha bônus: virava só troca
  // de caixa em palavra comum ("pensar" → "Pensar"). Seguir o termo, segue.
  const starts = [...root.next.keys()].filter((id) => vocab.pieces[id].trim().length >= 2)
  return {
    terms: terms.length,
    session: () => biasSession(root, starts),
    fixText: (text) => fixWithVocabulary(text, terms)
  }
}
