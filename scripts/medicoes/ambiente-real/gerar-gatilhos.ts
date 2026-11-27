// Layout novo das memórias (teste): para cada memória, a IA escreve no cabeçalho
//   tema: projeto/assunto genérico · gatilhos: 3–6 jeitos de o usuário pedir isso, com as palavras dele
//   termos: nomes próprios, números e sinônimos que alguém usaria para falar disso
// É o que o memorista passará a gravar (uma vez, ao gravar), para a busca casar o pedido com
// "como o usuário pediria". A IA vê SÓ a memória — nunca as perguntas do teste.
// Escreve uma cópia em <ambiente>/memorias-v2 (as originais não mudam).
//
//   npx esbuild scripts/medicoes/ambiente-real/gerar-gatilhos.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/ambiente-real/.gatilhos.tmp.mjs
//   node scripts/medicoes/ambiente-real/.gatilhos.tmp.mjs [--ambiente ~/agent-code-ambiente-real] [--modelo claude-sonnet-5-5] [--lote 10]
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { listMemoryFiles } from '../../../src/main/memoryIndex'

const arg = (k: string, def: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : def }
const AMB = arg('ambiente', join(homedir(), 'agent-code-ambiente-real')).replace(/^~/, homedir())
const MODELO = arg('modelo', 'claude-sonnet-5-5')
const LOTE = Number(arg('lote', '10'))

const SISTEMA = `Você prepara memórias de um assistente de programação para serem ACHADAS depois.
Para cada memória, escreva:
- "tema": o projeto ou assunto, genérico e curto (ex.: "agent-code", "gabarito", "brotai", "eleicoes", "medstone", "geral").
- "gatilhos": 3 a 6 frases curtas de como o usuário pediria algo em que esta memória importa, do jeito informal dele (sem acento, abreviado, curto, como numa conversa). Varie: pedido direto, reclamação, pergunta curta.
- "termos": até 10 nomes próprios, números, siglas e sinônimos que apareceriam numa conversa sobre isso.
Responda SOMENTE com JSON: {"<caminho>": {"tema": "...", "gatilhos": ["..."], "termos": ["..."]}}`

async function perguntar(prompt: string): Promise<{ texto: string; tokens: number }> {
  let texto = ''
  let tokens = 0
  for await (const m of query({ prompt, options: { model: MODELO, tools: [], maxTurns: 1, settingSources: [], strictMcpConfig: true, mcpServers: {}, systemPrompt: SISTEMA, persistSession: false, executable: 'node' } })) {
    if (m.type === 'assistant') for (const b of m.message.content as Array<{ type: string; text?: string }>) if (b.type === 'text') texto += b.text ?? ''
    if (m.type === 'result') {
      const u = (m as { usage?: Record<string, number> }).usage ?? {}
      tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
    }
  }
  return { texto, tokens }
}

/** Insere tema, gatilhos e termos no cabeçalho (cria um se não houver), sem mexer no resto. */
export function comLayoutNovo(conteudo: string, d: { tema?: string; gatilhos?: string[]; termos?: string[] }): string {
  const linhas: string[] = []
  if (d.tema) linhas.push(`tema: ${d.tema}`)
  if (d.gatilhos?.length) linhas.push('gatilhos:', ...d.gatilhos.map((g) => `  - ${JSON.stringify(g)}`))
  if (d.termos?.length) linhas.push(`termos: ${JSON.stringify(d.termos)}`)
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(conteudo)
  if (!m) return `---\n${linhas.join('\n')}\n---\n${conteudo}`
  const semAntigos = m[1].replace(/^(tema|termos):.*$/gm, '').replace(/^gatilhos:\n(\s+-.*\n?)*/m, '').replace(/\n{2,}/g, '\n').trim()
  return `---\n${semAntigos}\n${linhas.join('\n')}\n---\n${conteudo.slice(m[0].length)}`
}

async function main(): Promise<void> {
  const origem = join(AMB, 'memorias')
  const destino = join(AMB, 'memorias-v2')
  // Retomável: a cópia só é criada uma vez e memória que já tem gatilhos não é refeita.
  if (!existsSync(destino)) cpSync(origem, destino, { recursive: true })
  const files = listMemoryFiles(origem).filter((f) => !/^gatilhos:/m.test(readFileSync(join(destino, f.relPath), 'utf8')))
  console.log(`${files.length} memória(s) sem gatilhos`)
  let total = 0
  for (let i = 0; i < files.length; i += LOTE) {
    const lote = files.slice(i, i + LOTE)
    const texto = lote.map((f) => `### ${f.relPath}\n${readFileSync(join(origem, f.relPath), 'utf8').slice(0, 2500)}`).join('\n\n')
    const r = await perguntar(`# MEMÓRIAS\n\n${texto}`)
    total += r.tokens
    const json = /\{[\s\S]*\}/.exec(r.texto)?.[0]
    if (!json) throw new Error(`lote ${i / LOTE + 1}: sem JSON`)
    const dados = JSON.parse(json) as Record<string, { tema?: string; gatilhos?: string[]; termos?: string[] }>
    for (const f of lote) {
      const d = dados[f.relPath]
      if (!d) continue
      const arq = join(destino, f.relPath)
      writeFileSync(arq, comLayoutNovo(readFileSync(arq, 'utf8'), d))
    }
    console.log(`lote ${i / LOTE + 1}/${Math.ceil(files.length / LOTE)} · ${r.tokens} tokens`)
  }
  console.log(`memorias-v2 pronta · ${total} tokens no total`)
}

main().catch((e) => { console.error(e); process.exit(1) })
