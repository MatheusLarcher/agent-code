// Gabarito do ambiente real: o Opus (modelo DIFERENTE do seletor avaliado, o Sonnet) lê o
// acervo inteiro e diz, para cada pedido real, quais memórias deveriam entrar. Gera o
// casos.json do avaliador. O Erick confere uma amostra (revisao.md) antes de valer.
//
//   npx esbuild scripts/medicoes/ambiente-real/rotular.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/ambiente-real/.rotular.tmp.mjs
//   node scripts/medicoes/ambiente-real/.rotular.tmp.mjs [--ambiente ~/agent-code-ambiente-real] [--lote 10] [--modelo claude-opus-5-5]
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { listMemoryFiles } from '../../../src/main/memoryIndex'
import { memoryFileIndex } from '../../../src/main/memory/memoryFileCache'

const arg = (k: string, def: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : def }
const AMB = arg('ambiente', join(homedir(), 'agent-code-ambiente-real')).replace(/^~/, homedir())
const LOTE = Number(arg('lote', '10'))
const MODELO = arg('modelo', 'claude-opus-5-5')

interface Pedido { id: string; projeto: string; texto: string; conversa?: string }
interface Rotulo { esperadas: string[]; aceitaveis: string[]; motivo: string }

const SISTEMA = `Você monta o GABARITO de um teste de escolha de memórias de um assistente de programação.
O usuário (Erick) tem um acervo de memórias. A cada mensagem dele, um seletor escolhe quais memórias entram no contexto.
Para cada pedido, decida com rigor:
- "esperadas": memórias SEM as quais a resposta ficaria errada, incompleta ou fora do que o Erick já pediu antes (regra do projeto, decisão tomada, fato específico). Só o que é claramente necessário.
- "aceitaveis": memórias relacionadas que ajudariam mas não são necessárias, e regras gerais de jeito de responder (ex.: explicar simples) quando o pedido pede uma explicação.
- A maioria dos pedidos do dia a dia NÃO precisa de memória nenhuma: nesse caso, as duas listas vazias.
Use o contexto (mensagens anteriores) para entender pedidos curtos como "me dá o link".
Responda SOMENTE com JSON: {"<id>": {"esperadas": ["caminho.md"], "aceitaveis": [], "motivo": "1 frase"}, ...}. Use os caminhos exatamente como aparecem.`

function acervo(dir: string): { texto: string; caminhos: Set<string> } {
  const index = memoryFileIndex(dir)
  const files = listMemoryFiles(dir)
  const partes = files.map((f) => `### ${f.relPath}\n${(index.byRelPath.get(f.relPath)?.content ?? '').slice(0, 2500)}`)
  return { texto: partes.join('\n\n'), caminhos: new Set(files.map((f) => f.relPath)) }
}

async function perguntar(prompt: string): Promise<string> {
  let texto = ''
  const q = query({
    prompt,
    options: { model: MODELO, tools: [], maxTurns: 1, settingSources: [], strictMcpConfig: true, mcpServers: {}, systemPrompt: SISTEMA, persistSession: false, executable: 'node' }
  })
  for await (const m of q) {
    if (m.type === 'assistant') for (const b of (m.message.content as Array<{ type: string; text?: string }>)) if (b.type === 'text') texto += b.text ?? ''
  }
  return texto
}

async function main(): Promise<void> {
  const amostra = JSON.parse(readFileSync(join(AMB, 'amostra.json'), 'utf8')) as Pedido[]
  const { texto, caminhos } = acervo(join(AMB, 'memorias'))
  const rotulos: Record<string, Rotulo> = {}
  for (let i = 0; i < amostra.length; i += LOTE) {
    const lote = amostra.slice(i, i + LOTE)
    const pedidos = lote.map((p) => `## ${p.id}\n${p.conversa ? `Contexto (mensagens anteriores):\n${p.conversa}\n` : ''}Pedido: ${p.texto}`).join('\n\n')
    const resposta = await perguntar(`# ACERVO DE MEMÓRIAS\n\n${texto}\n\n# PEDIDOS\n\n${pedidos}`)
    const json = /\{[\s\S]*\}/.exec(resposta)?.[0]
    if (!json) throw new Error(`lote ${i / LOTE + 1}: resposta sem JSON`)
    const dados = JSON.parse(json) as Record<string, Partial<Rotulo>>
    for (const p of lote) {
      const d = dados[p.id] ?? {}
      const valido = (xs: unknown): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && caminhos.has(x)) : [])
      const esperadas = valido(d.esperadas)
      rotulos[p.id] = { esperadas, aceitaveis: valido(d.aceitaveis).filter((x) => !esperadas.includes(x)), motivo: String(d.motivo ?? '') }
    }
    console.log(`lote ${i / LOTE + 1}/${Math.ceil(amostra.length / LOTE)} rotulado`)
  }
  const casos = amostra.map((p) => ({
    id: p.id,
    pedido: p.texto,
    ...(p.conversa ? { conversa: p.conversa } : {}),
    esperadas: rotulos[p.id].esperadas,
    aceitaveis: rotulos[p.id].aceitaveis,
    nota: rotulos[p.id].motivo,
    tags: [rotulos[p.id].esperadas.length ? 'precisa' : 'nada', `projeto:${p.projeto}`]
  }))
  writeFileSync(join(AMB, 'casos.json'), JSON.stringify({ casos }, null, 2))
  // Amostra para o Erick conferir: todos os que precisam de memória + alguns sem.
  const comMemoria = casos.filter((c) => c.esperadas.length)
  const sem = casos.filter((c) => !c.esperadas.length).slice(0, 10)
  const linhas = [...comMemoria, ...sem].map((c) => `- **${c.pedido.replace(/\n/g, ' ')}**\n  - deveria entrar: ${c.esperadas.join(', ') || 'nenhuma'}${c.aceitaveis.length ? `\n  - pode entrar: ${c.aceitaveis.join(', ')}` : ''}\n  - por quê: ${c.nota}`)
  writeFileSync(join(AMB, 'revisao.md'), `# Gabarito para conferir (${comMemoria.length} pedidos com memória, ${sem.length} sem)\n\nMarque o que estiver errado.\n\n${linhas.join('\n')}\n`)
  console.log(`casos: ${casos.length} (${comMemoria.length} precisam de memória) · revisão em ${join(AMB, 'revisao.md')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
