/**
 * Uso da assinatura do Kimi Code: `GET {base}/v1/usages` com a chave oficial
 * (mesma identidade honesta do "Testar conexão"). Sondado ao vivo em 27/10/2026:
 * `usages.limit_5h` e `usages.limit_month_total` trazem `used_ratio` (0..1) e
 * `reset_time` (ISO). A chave só vai no cabeçalho; o resultado nunca a carrega.
 */
import type { KimiUsage, KimiUsageWindow } from '../../shared/ipc'
import { kimiCodingBase, kimiHeaders, type KimiRegion } from './kimiIdentity'

type Fetch = typeof fetch

function parseWindow(raw: unknown): KimiUsageWindow | undefined {
  const w = raw as { used_ratio?: unknown; reset_time?: unknown } | null
  const ratio = Number(w?.used_ratio)
  if (!w || !Number.isFinite(ratio)) return undefined
  const reset = typeof w.reset_time === 'string' ? Date.parse(w.reset_time) : NaN
  return { usedRatio: Math.min(1, Math.max(0, ratio)), resetsAt: Number.isFinite(reset) ? reset : undefined }
}

/** Lê o uso; `null` sem chave, com erro ou resposta sem as janelas. */
export async function fetchKimiUsage(
  apiKey: string,
  region: KimiRegion,
  opts: { fetchImpl?: Fetch; appVersion?: string } = {}
): Promise<KimiUsage | null> {
  const key = apiKey.trim()
  if (!key) return null
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${kimiCodingBase(region)}/v1/usages`, {
      headers: kimiHeaders(key, opts.appVersion),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { usages?: Record<string, unknown> } | null
    const session = parseWindow(json?.usages?.limit_5h)
    const month = parseWindow(json?.usages?.limit_month_total)
    if (!session && !month) return null
    return { session, month }
  } catch {
    return null
  }
}
