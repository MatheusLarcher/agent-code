// Resume as rodadas da medição "tempo até começar a responder": mediana e faixa
// por cenário e por mensagem, e as memórias escolhidas lado a lado.
//
//   node scripts/medicoes/resumir-inicio-resposta.mjs A=<rodada> B=<rodada> C=<rodada>
//
// <rodada> é a pasta em docs/bateria/resultados/. Saída em Markdown no stdout.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoriasInjetadas, transcriptLines } from '../bateria/memorias.mjs'
import { claudeProjectSlug } from '../replay/measure.mjs'

const RES = path.join(import.meta.dirname, '..', '..', 'docs', 'bateria', 'resultados')

// Marcas cumulativas do turn-timing (ms desde o envio) → as fatias medidas.
export const FATIAS = [
  ['Pedido chega ao Claude', (m) => m.enqueued],
  ['Escolha de memórias', (m) => (m.memorySelection ?? NaN) - (m.otherConversations ?? NaN)],
  ['Catálogo de skills', (m) => (m.skillCatalog ?? NaN) - (m.memoryCatalog ?? NaN)],
  ['Subida do CLI', (m) => (m.cliInit ?? NaN) - (m.enqueued ?? NaN)],
  ['1º texto', (m) => m.firstDelta]
]

export function mediana(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

const seg = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/** { [tarefa]: [{ tempos, memorias }] } das repetições de uma rodada. */
function ler(rodada) {
  const dir = path.join(RES, rodada)
  if (!existsSync(dir)) throw new Error(`rodada não encontrada: ${dir}`)
  const por = {}
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    if (r.status === 'erro') continue
    // Memórias relidas do transcript: rodadas antigas gravaram também as dos observadores.
    const projeto = path.join(os.homedir(), 'agent-code-bateria', rodada, f.replace(/\.json$/, ''), 'projeto')
    const linhas = transcriptLines(path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(projeto)))
    ;(por[r.tarefa] ??= []).push({ arquivo: f, tempos: r.tempos ?? [], memorias: linhas.length ? memoriasInjetadas(linhas) : r.memorias ?? [] })
  }
  return por
}

export function tabela(por) {
  const linhas = ['| Tarefa / mensagem | ' + FATIAS.map(([n]) => n).join(' | ') + ' |', '|---|' + FATIAS.map(() => '---|').join('')]
  for (const [tarefa, reps] of Object.entries(por)) {
    const nMsgs = Math.max(...reps.map((r) => r.tempos.length))
    for (let i = 0; i < nMsgs; i++) {
      const cel = FATIAS.map(([, f]) => {
        const xs = reps.map((r) => r.tempos[i]).filter(Boolean).map(f).filter((x) => Number.isFinite(x))
        return xs.length ? `${seg(mediana(xs))} (${seg(Math.min(...xs))}–${seg(Math.max(...xs))}, n=${xs.length})` : '—'
      })
      linhas.push(`| ${tarefa} · ${i + 1}ª | ${cel.join(' | ')} |`)
    }
  }
  return linhas.join('\n')
}

if (process.argv[1] === import.meta.filename) {
  const cen = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')))
  const dados = Object.fromEntries(Object.entries(cen).map(([k, v]) => [k, ler(v)]))
  for (const [k, por] of Object.entries(dados)) console.log(`\n### Cenário ${k} (${cen[k]})\n\n${tabela(por)}`)
  if (dados.A && dados.B) {
    console.log('\n### Memórias escolhidas, A × B (por repetição e mensagem)\n\n| Tarefa · rep · msg | A | B | Iguais? |\n|---|---|---|---|')
    for (const tarefa of Object.keys(dados.A)) {
      const a = dados.A[tarefa], b = dados.B[tarefa] ?? []
      for (let r = 0; r < Math.max(a.length, b.length); r++) {
        const n = Math.max(a[r]?.memorias.length ?? 0, b[r]?.memorias.length ?? 0)
        for (let i = 0; i < n; i++) {
          const ma = a[r]?.memorias[i] ?? [], mb = b[r]?.memorias[i] ?? []
          const igual = ma.length === mb.length && ma.every((x) => mb.includes(x))
          console.log(`| ${tarefa} · r${r + 1} · ${i + 1}ª | ${ma.join('<br>') || '(nenhuma)'} | ${mb.join('<br>') || '(nenhuma)'} | ${igual ? 'sim' : '**não**'} |`)
        }
      }
    }
  }
}
