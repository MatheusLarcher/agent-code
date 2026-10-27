/**
 * Sonda real: o que o endpoint do Kimi Code aceita do que o CLI 2.1.304 manda.
 * Só roda com LIVE_KIMI=1. Lê a chave de kimi-sonda/credencial.json (fora do repo)
 * e a requisição principal gravada pelo captura.mjs do planejamento
 * (docs/spec/plano-20261025-1150/_sandbox/captura/saida/kimi2, fora do git).
 * Repete os cabeçalhos do próprio CLI (identidade honesta) e grava a tabela em
 * _sandbox/sonda-kimi/RESULTADO.md. Pedidos curtos ("responda ok").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const credFile = join(process.env.KIMI_SONDA_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'agent-code', 'kimi-sonda'), 'credencial.json')
const sandbox = join(process.cwd(), 'docs', 'spec', 'plano-20261025-1150', '_sandbox')
const capture = join(sandbox, 'captura', 'saida', 'kimi2', '03-POST-_v1_messages_beta_true.json')
const live = process.env.LIVE_KIMI === '1' && existsSync(credFile) && existsSync(capture)
const BASE = 'https://api.kimi.ai/coding'

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }>; tools?: Array<Record<string, unknown>> }
interface Outcome { status: number; error?: string; stopReason?: string; types: string[]; usage?: Record<string, unknown>; toolUse?: Record<string, unknown>; content: unknown[] }

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PDF_MIN = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 50]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 10 20 Td (BANANA 42) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
).toString('base64')

describe.skipIf(!live)('Sonda real do Kimi Code', () => {
  const { apiKey } = live ? (JSON.parse(readFileSync(credFile, 'utf8')) as { apiKey: string }) : { apiKey: '' }
  const captured = live ? (JSON.parse(readFileSync(capture, 'utf8')) as { headers: Record<string, string>; body: Body }) : null
  const rows: string[] = []

  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(captured!.headers)) {
      if (['authorization', 'x-api-key', 'content-length', 'host', 'accept-encoding'].includes(k.toLowerCase())) continue
      h[k] = v
    }
    return { ...h, authorization: `Bearer ${apiKey}`, ...extra }
  }
  const clone = (): Body => JSON.parse(JSON.stringify(captured!.body)) as Body
  const redact = (s: string): string => s.split(apiKey).join('[CHAVE]')

  async function send(body: unknown, path = '/v1/messages', extra: Record<string, string> = {}): Promise<Outcome> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(extra), body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    const text = redact(await res.text())
    const out: Outcome = { status: res.status, types: [], content: [] }
    if (!text.includes('event:')) {
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; stop_reason?: string; usage?: Record<string, unknown>; content?: Array<{ type: string }>; input_tokens?: number }
        if (j.error) out.error = j.error.message ?? text.slice(0, 300)
        out.stopReason = j.stop_reason
        out.usage = j.usage ?? (j.input_tokens !== undefined ? { input_tokens: j.input_tokens } : undefined)
        out.content = j.content ?? []
        out.types = (j.content ?? []).map((c) => c.type)
      } catch {
        out.error = text.slice(0, 300)
      }
      return out
    }
    const blocks: Record<number, Record<string, unknown>> = {}
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      let ev: Record<string, any>
      try { ev = JSON.parse(line.slice(5)) } catch { continue }
      if (ev.type === 'error') out.error = ev.error?.message ?? JSON.stringify(ev).slice(0, 300)
      if (ev.type === 'message_start') out.usage = ev.message?.usage
      if (ev.type === 'message_delta') {
        out.stopReason = ev.delta?.stop_reason
        out.usage = { ...(out.usage ?? {}), ...(ev.usage ?? {}) }
      }
      if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block, _json: '' }
      if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]
        if (!b) continue
        if (ev.delta?.type === 'thinking_delta') b.thinking = String(b.thinking ?? '') + ev.delta.thinking
        if (ev.delta?.type === 'signature_delta') b.signature = String(b.signature ?? '') + ev.delta.signature
        if (ev.delta?.type === 'text_delta') b.text = String(b.text ?? '') + ev.delta.text
        if (ev.delta?.type === 'input_json_delta') b._json = String(b._json) + ev.delta.partial_json
      }
    }
    for (const b of Object.values(blocks)) {
      if (b.type === 'tool_use') b.input = b._json ? JSON.parse(String(b._json)) : {}
      delete b._json
      out.content.push(b)
      out.types.push(String(b.type))
      if (b.type === 'tool_use' && !out.toolUse) out.toolUse = b
    }
    return out
  }

  function record(item: string, o: Outcome, note = ''): void {
    const ok = o.status >= 200 && o.status < 300 && !o.error
    const usage = o.usage ? Object.entries(o.usage).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ') : ''
    const line = `| ${item} | ${ok ? 'aceito' : 'recusado'} | ${o.status} | ${(o.error ?? '').replace(/\|/g, '/').slice(0, 220)} | ${o.types.join(',')} ${o.stopReason ? `(${o.stopReason})` : ''} ${usage} | ${note} |`
    rows.push(line)
    console.log(line)
  }

  const withPrompt = (b: Body, text: string): Body => {
    const user = b.messages[0]
    const parts = user.content as Array<{ type: string; text?: string }>
    parts[parts.length - 1] = { type: 'text', text }
    return b
  }

  it('roda os itens e grava RESULTADO.md', async () => {
    // 1. A requisição principal exatamente como o CLI manda (stream, betas, system em messages, defer_loading, cache_control, thinking, effort).
    const full = await send(clone())
    record('1. requisição principal do CLI, como enviada', full)
    const again = await send(clone())
    record('1b. mesma requisição de novo (cache)', again, 'cache_read_input_tokens na 2ª?')

    // 2. Pensamento desligado / ausente.
    const off = clone(); off.thinking = { type: 'disabled' }
    record('2a. thinking disabled', await send(off))
    const none = clone(); delete none.thinking
    record('2b. thinking ausente', await send(none))

    // 3. Esforço: os cinco níveis.
    for (const effort of ['low', 'medium', 'xhigh', 'max']) {
      const b = clone(); b.output_config = { effort }
      record(`3. output_config.effort=${effort}`, await send(b))
    }

    // 4. Ida e volta de ferramenta com pensamento, e resultado tool_reference (ToolSearch).
    const ask = withPrompt(clone(), 'Use a ferramenta Glob com pattern "*.md" agora, sem explicar.')
    const first = await send(ask)
    record('4a. pedido que leva a tool_use', first, first.toolUse ? `tool=${String(first.toolUse.name)}` : 'sem tool_use')
    if (first.toolUse) {
      const round = withPrompt(clone(), 'Use a ferramenta Glob com pattern "*.md" agora, sem explicar.')
      const assistant = { role: 'assistant', content: first.content }
      const toolResult = { type: 'tool_result', tool_use_id: first.toolUse.id, content: 'README.md\nAGENTS.md' }
      round.messages.push(assistant, { role: 'user', content: [toolResult, { type: 'text', text: 'Agora responda ok.' }] })
      record('4b. volta com tool_result (thinking + tool_use no histórico)', await send(round))
      const noThinking = withPrompt(clone(), 'x')
      noThinking.messages = [...round.messages.slice(0, -2), { role: 'assistant', content: first.content.filter((c) => (c as { type: string }).type !== 'thinking') }, round.messages[round.messages.length - 1]]
      record('4c. volta sem o bloco thinking no histórico', await send(noThinking))
      const ref = withPrompt(clone(), 'Use a ferramenta Glob com pattern "*.md" agora, sem explicar.')
      ref.messages.push(assistant, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.toolUse.id, content: [{ type: 'tool_reference', tool_name: 'Write' }] }, { type: 'text', text: 'Responda ok.' }] })
      record('4d. tool_result com tool_reference (ToolSearch)', await send(ref))
    }

    // 5. Busca de ferramentas sem o beta / sem defer_loading.
    const noDefer = clone(); noDefer.tools = noDefer.tools!.filter((t) => !t.defer_loading)
    record('5. sem a ferramenta diferida (defer_loading)', await send(noDefer))

    // 6. Imagem e PDF.
    const img = withPrompt(clone(), 'Que cor tem a imagem? Uma palavra.')
    ;(img.messages[0].content as unknown[]).push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } })
    record('6a. bloco image (base64)', await send(img))
    const pdf = withPrompt(clone(), 'Que texto tem o PDF? Só o texto.')
    ;(pdf.messages[0].content as unknown[]).push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_MIN } })
    const pdfOut = await send(pdf)
    record('6b. bloco document (PDF)', pdfOut, JSON.stringify(pdfOut.content.filter((c) => (c as { type: string }).type === 'text')).slice(0, 80))

    // 7. count_tokens com o corpo do CLI.
    const ct = clone(); delete ct.stream; delete ct.max_tokens; delete ct.metadata
    record('7. POST /v1/messages/count_tokens', await send(ct, '/v1/messages/count_tokens'))

    // 8. Ferramenta de servidor web_search (o roteador manda à Anthropic; aqui só registra).
    const ws = clone(); ws.tools = [...ws.tools!, { type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]
    record('8. ferramenta de servidor web_search_20250305', await send(ws))

    // 9. Corpo acima de 2 MB.
    const big = withPrompt(clone(), 'x'.repeat(2_200_000))
    record('9. corpo > 2 MB', await send(big))

    const out = join(sandbox, 'sonda-kimi')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'RESULTADO.md'),
      `# Sonda real do Kimi Code — ${new Date().toISOString()}\n\nPlano Plus, região intl, chave oficial, cabeçalhos do claude-cli 2.1.304.\n\n| item | resultado | status | erro | blocos / uso | nota |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`
    )
    expect(full.status).toBeGreaterThan(0)
  }, 1_800_000)
})
