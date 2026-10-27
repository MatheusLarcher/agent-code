/**
 * "Testar conexão" do Kimi: descobre, com a chave do Kimi Code, a região que a
 * aceita, a janela de contexto do K3.1 Pro e quais modelos do seletor o plano
 * libera. Sondado ao vivo em 26/10/2026 (plano Plus):
 * - `GET /v1/models` lista os modelos com `context_length` (k3.1-pro = 262144
 *   no Plus); um pedido mínimo com o beta de 1M responde 200 e não prova a janela.
 * - `k3.1-pro-highspeed` aparece na lista mesmo sem acesso: só o pedido diz
 *   (403 `permission_error` "…does not have access to k3.1-pro-highspeed").
 * - Chave inválida: 401 `invalid_authentication_error`.
 * A chave só vai no cabeçalho; o resultado nunca a carrega.
 */
import { KIMI_CONTEXT_WINDOWS, KIMI_MODELS, type KimiConnectionResult } from '../../shared/ipc'
import { kimiCodingBase, kimiHeaders, type KimiRegion } from './kimiIdentity'

const REGIONS: readonly KimiRegion[] = ['intl', 'cn']
const TIMEOUT_MS = 30_000
const MESSAGE_TIMEOUT_MS = 90_000

type Fetch = typeof fetch

interface ModelInfo {
  id: string
  context_length?: number
}

/** Janela do plano a partir do `context_length` do k3.1-pro. */
export function windowFromContextLength(length: number | undefined): number {
  const [small, large] = KIMI_CONTEXT_WINDOWS
  return typeof length === 'number' && length >= large ? large : small
}

interface Ctx {
  apiKey: string
  fetchImpl: Fetch
  appVersion: string
}

async function listModels(region: KimiRegion, ctx: Ctx): Promise<{ status: number; models: ModelInfo[] }> {
  const res = await ctx.fetchImpl(`${kimiCodingBase(region)}/v1/models`, {
    headers: kimiHeaders(ctx.apiKey, ctx.appVersion),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) return { status: res.status, models: [] }
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null
  const data = Array.isArray(json?.data) ? json.data : []
  const models = data.filter((m): m is ModelInfo => typeof (m as ModelInfo)?.id === 'string')
  return { status: res.status, models }
}

/** O plano libera o modelo? Pedido mínimo. O sinal de plano é só o 403
 *  (`permission_error`); 2xx = liberado. Resultado incerto (429 transitório,
 *  5xx ou demora — medido: 7 s a 71 s no mesmo minuto) só conta como liberado
 *  para o K3.1 Pro, que todo plano do Kimi Code inclui; o Highspeed fica de fora. */
async function modelAllowed(region: KimiRegion, model: string, ctx: Ctx): Promise<boolean> {
  try {
    const res = await ctx.fetchImpl(`${kimiCodingBase(region)}/v1/messages`, {
      method: 'POST',
      headers: { ...kimiHeaders(ctx.apiKey, ctx.appVersion), 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS)
    })
    await res.body?.cancel().catch(() => undefined)
    if (res.ok) return true
    if (res.status === 401 || res.status === 403) return false
  } catch {
    // demora ou rede: incerto
  }
  return model === 'k3.1-pro'
}

function planLabel(window: number, models: string[]): string {
  const name = models.includes('k3.1-pro-highspeed') ? 'K3.1 Pro + Highspeed' : 'K3.1 Pro'
  return `${name}, janela de ${window >= KIMI_CONTEXT_WINDOWS[1] ? '1M' : '256K'}`
}

export async function testKimiConnection(
  apiKey: string,
  opts: { fetchImpl?: Fetch; appVersion?: string } = {}
): Promise<KimiConnectionResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: 'Cole a chave do Kimi Code antes de testar.' }
  const ctx: Ctx = { apiKey: key, fetchImpl: opts.fetchImpl ?? fetch, appVersion: opts.appVersion ?? 'dev' }
  try {
    for (const region of REGIONS) {
      const { status, models } = await listModels(region, ctx)
      if (status === 401 || status === 403) continue
      if (status !== 200) return { ok: false, message: `O Kimi respondeu ${status} ao listar os modelos. Tente de novo em instantes.` }
      const listed = new Set(models.map((m) => m.id))
      const window = windowFromContextLength(models.find((m) => m.id === 'k3.1-pro')?.context_length)
      const allowed: string[] = []
      for (const { id } of KIMI_MODELS) {
        if (listed.has(id) && (await modelAllowed(region, id, ctx))) allowed.push(id)
      }
      if (allowed.length === 0) {
        return { ok: false, region, message: 'A chave funciona, mas o plano não libera o K3.1 Pro. Confira a assinatura no console do Kimi Code.' }
      }
      return { ok: true, region, contextWindow: window, models: allowed, message: `Conectado: ${planLabel(window, allowed)}.` }
    }
    return { ok: false, message: 'Chave do Kimi inválida ou expirada. Gere outra em kimi.ai/code/console.' }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'o Kimi demorou demais para responder' : 'sem conexão com o Kimi'
    return { ok: false, message: `Não consegui testar: ${reason}.` }
  }
}
