// Memórias que o app injetou em cada mensagem do usuário, lidas do transcript.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Linhas JSONL de todos os transcripts de uma pasta (subagentes incluídos). */
export function transcriptLines(dir) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) for (const l of readFileSync(p, 'utf8').split('\n')) { try { if (l) out.push(JSON.parse(l)) } catch { /* linha parcial */ } }
    }
  }
  walk(dir)
  return out
}

/**
 * Por mensagem do usuário, na ordem: os caminhos das memórias que foram junto
 * (`--- Memória relevante: <caminho> ---`). Os observadores (PO, memorista) gravam
 * sessões na mesma pasta; só as mensagens da conversa trazem `turnAttributionKey`.
 */
export function memoriasInjetadas(lines) {
  return lines
    .filter((l) => l.type === 'user' && !l.isSidechain && l.turnAttributionKey && l.message)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .map((l) => {
      const c = l.message.content
      return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : ''
    })
    // Linha só com tool_result não é mensagem do usuário.
    .filter((texto) => texto.trim())
    .map((texto) => [...texto.matchAll(/^--- Memória relevante: (.+?) ---$/gm)].map((m) => m[1]))
}
