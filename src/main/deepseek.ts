/**
 * DeepSeek como provedor: o mesmo desvio do Ollama Cloud. A DeepSeek expõe uma
 * API compatível com a Messages da Anthropic, então o CLI empacotado roda sem
 * mudança com o `ANTHROPIC_BASE_URL` apontando para lá.
 * https://api-docs.deepseek.com/guides/anthropic_api
 *
 * Fica fora do agentSession.ts (já enorme): o env da sessão mora aqui.
 */
import { DEEPSEEK_BASE_URL, isDeepSeekModel, type DeepSeekBalance, type TokenUsage } from '../shared/ipc'

/** Preço do V4.1 Flash em USD por 1M de tokens, no horário de pico (o mais
 *  caro): o custo mostrado é "estimado" e nunca fica abaixo do real. Único
 *  lugar dos preços. https://api-docs.deepseek.com/quick_start/pricing */
export const DEEPSEEK_PRICE_PER_MTOK = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 } as const

/** Custo estimado de um turno. A criação de cache não tem preço próprio na
 *  DeepSeek: conta como entrada sem cache. */
export function deepseekCostUsd(usage: TokenUsage | undefined): number | null {
  if (!usage) return null
  const p = DEEPSEEK_PRICE_PER_MTOK
  const miss = usage.input + usage.cacheWrite
  return (usage.cacheRead * p.cacheHit + miss * p.cacheMiss + usage.output * p.output) / 1_000_000
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Valida a resposta do /user/balance (`is_available`, `balance_infos[]`). */
export function parseDeepSeekBalance(json: unknown): DeepSeekBalance | null {
  const o = json as { is_available?: unknown; balance_infos?: unknown } | null
  if (!o || typeof o.is_available !== 'boolean') return null
  const infos = Array.isArray(o.balance_infos) ? o.balance_infos : []
  const usd = infos.find((b) => (b as { currency?: unknown })?.currency === 'USD') as { total_balance?: unknown } | undefined
  const total = usd ? Number(usd.total_balance) : NaN
  return { available: o.is_available, totalUsd: Number.isFinite(total) ? total : null }
}

/** Saldo da conta. Sem chave, erro de rede ou resposta estranha: null (o
 *  badge some, não mostra número falso). A chave só vai no cabeçalho. */
export async function fetchDeepSeekBalance(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeepSeekBalance | null> {
  const key = apiKey.trim()
  if (!key) return null
  try {
    const res = await fetchImpl(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    return parseDeepSeekBalance(await res.json())
  } catch {
    return null
  }
}

/** Read de um .pdf numa sessão DeepSeek: a API compatível não aceita bloco
 *  `document`, então o PreToolUse nega e manda para o `ler_pdf` do app. */
export function pdfReadDenied(model: string | undefined, toolName: string, toolInput: unknown): boolean {
  if (toolName !== 'Read' || !isDeepSeekModel(model)) return false
  const path = (toolInput as { file_path?: unknown } | null)?.file_path
  return typeof path === 'string' && /\.pdf\s*$/i.test(path)
}

export const DEEPSEEK_MISSING_KEY_ERROR =
  'Modelo DeepSeek selecionado, mas falta a API key. Abra Configurações → DeepSeek e cole sua chave.'

export const DEEPSEEK_NO_CONFIG_DIR_ERROR =
  'Não consegui preparar a pasta do CLI sem o login do Claude; a sessão DeepSeek não foi aberta para não enviar sua credencial da Anthropic à DeepSeek.'

/**
 * Ambiente do CLI numa sessão DeepSeek. O SDK SUBSTITUI o ambiente do
 * subprocesso (não mescla), por isso parte de `base` (o process.env).
 * `ANTHROPIC_API_KEY` vazio e `CLAUDE_CONFIG_DIR` sem login guardado: com
 * qualquer um dos dois o CLI preferiria a credencial da Anthropic ao token e a
 * mandaria para a DeepSeek. Todos os apelidos de modelo (e os subagentes) vão
 * para o mesmo modelo, senão um `haiku` interno do CLI pediria um modelo que a
 * DeepSeek não tem.
 */
export function deepseekSessionEnv(
  base: NodeJS.ProcessEnv,
  model: string,
  apiKey: string,
  configDir: string
): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model
  }
}
