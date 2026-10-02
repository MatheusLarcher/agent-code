/**
 * Costura do código ao vivo (`tool-input-delta`) — PURO.
 *
 * O main manda, no máximo a cada 100 ms, as ÚLTIMAS 40 linhas do texto novo e
 * quantas linhas ele tem ao todo (`totalLines`). Caudas seguidas se sobrepõem:
 * cada uma reescreve as linhas [totalLines − tamanho da cauda, totalLines) de um
 * vetor por bloco; linha nunca vista fica `null` (a tela mostra um placeholder
 * apagado, nunca texto inventado). Quando o `tool-use` final chega (mesmo id), a
 * entrada completa dele substitui o texto costurado — isso é de quem mostra.
 *
 * O MultiEdit transmite só o item em escrita: item novo (texto antigo
 * diferente, ou menos linhas que antes) recomeça o vetor.
 */
import type { ToolInputDelta } from '../../office/liveInput'

export interface LiveBlock {
  toolUseId: string
  name: ToolInputDelta['name']
  filePath?: string
  /** As últimas ~40 linhas do texto antigo (Edit/MultiEdit). */
  oldText?: string
  /** O texto novo, por linha; null = ainda não visto. */
  lines: ReadonlyArray<string | null>
  totalLines: number
  done: boolean
  /** Quando chegou o último pedaço (ms). */
  at: number
}

export function stitch(prev: LiveBlock | undefined, d: ToolInputDelta, now: number): LiveBlock {
  const total = Math.max(0, d.totalLines)
  const tail = total === 0 ? [] : d.newText.split('\n')
  const restart =
    !prev || total < prev.totalLines || (d.oldText !== undefined && prev.oldText !== undefined && d.oldText !== prev.oldText)
  const lines: Array<string | null> = restart ? [] : prev.lines.slice(0, total)
  while (lines.length < total) lines.push(null)
  const start = Math.max(0, total - tail.length)
  for (let k = 0; k < tail.length && start + k < total; k++) lines[start + k] = tail[k]
  return {
    toolUseId: d.toolUseId,
    name: d.name,
    filePath: d.filePath ?? prev?.filePath,
    oldText: d.oldText ?? (restart ? undefined : prev?.oldText),
    lines,
    totalLines: total,
    done: d.done,
    at: now
  }
}

/** O texto costurado (buraco = linha vazia) e onde estão os buracos. */
export function liveText(b: LiveBlock): { text: string; gaps: boolean[] } {
  return { text: b.lines.map((l) => l ?? '').join('\n'), gaps: b.lines.map((l) => l === null) }
}
