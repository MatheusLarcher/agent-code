/**
 * Regras puras do roteador do Kimi (kimiRouter.ts é só o servidor).
 *
 * Sonda real de 26/10/2026 (src/main/kimi/kimiProbe.live.test.ts, plano Plus,
 * chave oficial, cabeçalhos do claude-cli 2.1.304) — o endpoint compatível com a
 * Anthropic ACEITA, sem adaptação: a requisição principal do CLI como sai (stream,
 * todos os betas, `system` dentro de `messages`, `defer_loading` + busca de
 * ferramentas, `tool_reference`, `cache_control` com cache de verdade,
 * `context_management`), `thinking` adaptive/desligado/ausente, `effort` nos cinco
 * níveis, ida e volta de ferramenta com e sem `thinking` no histórico, imagem
 * base64, `count_tokens`, a ferramenta de servidor `web_search_20250305` (o Kimi
 * executa a busca) e corpo > 2 MB.
 * RECUSA: bloco `document` (PDF) → 400. Adaptação: nenhuma no roteador; a sessão
 * Kimi nega o Read de .pdf e manda para o `ler_pdf` do app (como na DeepSeek).
 * RECUSA (CLI logado, flag de conta): blocos `tool_addition` → 400; adaptação em
 * hoistInlineTools (abaixo).
 *
 * Por isso o corpo vai ao Kimi como veio, com só duas mudanças possíveis: o bloco
 * das instruções da organização e as ferramentas inline levadas para `tools`. É a
 * lista de diferenças que o teste de paridade no fio aceita além das linhas de
 * identidade (KIMI_WIRE_ADAPTATIONS).
 *
 * Desvios do plano (registrados no relatório): o K3.1 Pro aceita pedido sem
 * pensamento e o Kimi tem web search — então o WebSearch fica no Kimi (não é
 * desviado para o Claude) e não há regra de "pensamento obrigatório".
 */
import { isKimiModel, KIMI_AUX_MODEL } from '../../shared/ipc'
import { isUsageExhausted } from '../providerQuota'

/** Diferenças de corpo que o roteador pode introduzir no pedido ao Kimi. */
export const KIMI_WIRE_ADAPTATIONS = ['organization-instructions', 'inline-tools-hoisted'] as const

/**
 * Ferramentas "inline" (achado ao vivo, 26/10/2026, CLI logado): com a flag de
 * conta `inline-tools-2026-09-15`, o CLI anuncia ferramentas MCP no meio da
 * conversa como blocos `tool_addition` dentro de uma mensagem `role: "system"`
 * — e o Kimi recusa o pedido inteiro (400 "Invalid request Error"; sem o bloco,
 * 200). A adaptação leva cada definição para a lista `tools` (mesmo nome,
 * descrição e schema, na ordem em que apareceram) e tira o bloco; mensagem que
 * fica vazia sai. O modelo vê as mesmas ferramentas; só a posição muda.
 * Devolve quantas foram movidas.
 */
export function hoistInlineTools(body: Record<string, unknown>): number {
  const messages = body.messages
  if (!Array.isArray(messages)) return 0
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: unknown }>) : []
  const names = new Set(tools.map((t) => t?.name))
  let moved = 0
  let touched = false
  for (const m of messages as Array<{ content?: unknown }>) {
    if (!Array.isArray(m?.content)) continue
    const kept = (m.content as Array<{ type?: string; tool?: { definition?: { name?: unknown } } }>).filter((part) => {
      if (part?.type !== 'tool_addition') return true
      touched = true
      const def = part.tool?.definition
      if (def && typeof def.name === 'string' && !names.has(def.name)) {
        tools.push(def)
        names.add(def.name)
        moved++
      }
      return false
    })
    m.content = kept
  }
  if (!touched) return 0
  body.tools = tools
  body.messages = (messages as Array<{ content?: unknown }>).filter((m) => !Array.isArray(m?.content) || m.content.length > 0)
  return moved
}

export type Route = 'kimi' | 'anthropic' | 'reject'

/** Destino de um pedido. Sem `model` (HEAD /api/hello, /api/*): Anthropic. */
export function routeFor(model: unknown): Route {
  if (typeof model !== 'string' || model === '') return 'anthropic'
  if (isKimiModel(model)) return 'kimi'
  if (model.startsWith('claude')) return 'anthropic'
  return 'reject'
}

/** Cabeçalhos que não se repassam (o fetch recalcula ou são do salto). */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade'])

/** Pedido à Anthropic: os cabeçalhos do CLI intactos (credencial Claude dele inclusive). */
export function anthropicHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || HOP_HEADERS.has(k.toLowerCase())) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Pedido ao Kimi: tira a credencial e o beta de OAuth da Anthropic, põe a chave
 *  do Kimi. O resto (User-Agent do CLI, betas, sessão) segue como veio. */
export function kimiHeaders(incoming: Record<string, string | string[] | undefined>, apiKey: string): Record<string, string> {
  const out = anthropicHeaders(incoming)
  for (const k of Object.keys(out)) {
    const low = k.toLowerCase()
    if (low === 'authorization' || low === 'x-api-key') delete out[k]
    if (low === 'anthropic-beta') {
      const betas = out[k].split(',').map((b) => b.trim()).filter((b) => b && b !== 'oauth-2025-04-20')
      if (betas.length) out[k] = betas.join(',')
      else delete out[k]
    }
  }
  out.authorization = `Bearer ${apiKey}`
  return out
}

/** Falha do Claude que liga a reserva de auxiliares no Kimi: sem credencial
 *  Claude no pedido, ou cota esgotada (429/403 com a frase de cota). 401 comum
 *  NÃO liga: o CLI renova o login e repete. */
export function claudeUnavailable(status: number, raw: string, hadCredential: boolean): boolean {
  if (!hadCredential) return true
  return (status === 429 || status === 403 || status === 402) && isUsageExhausted(raw)
}

/** O mesmo pedido, levado à reserva do Kimi: só o `model` muda. */
export function auxReserveBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, model: KIMI_AUX_MODEL }
}

/** Credencial Claude presente no pedido do CLI? */
export function hasClaudeCredential(headers: Record<string, string | string[] | undefined>): boolean {
  const auth = headers.authorization ?? headers['x-api-key']
  const value = Array.isArray(auth) ? auth.join('') : auth ?? ''
  return value.replace(/^Bearer\s*/i, '').trim().length > 0
}

/** Versão do registro: cabeçalhos com credencial redigida. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|x-api-key|cookie)$/i.test(k) ? `<redigido ${v.length} chars>` : v
  }
  return out
}
