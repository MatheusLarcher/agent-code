/**
 * Rede do celular: URL das rotas da ponte, `fetch` com prazo, e a escolha entre a
 * LAN do PC e o relay público (VPS).
 */

/** Prazo das chamadas normais: um endereço de LAN morto (celular saiu da rede) não
 *  pode segurar a tela por minutos até o TCP desistir. */
export const FETCH_TIMEOUT_MS = 12000

/** Erro de uma chamada à ponte: `status` é o HTTP (houve resposta) ou 0 (rede/prazo). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown = null
  ) {
    super(status ? `HTTP ${status}` : 'network')
  }
}

export function statusOf(err: unknown): number {
  return err instanceof HttpError ? err.status : 0
}

/** Texto humano para o que deu errado — 503/504 vêm do broker (o PC não está lá),
 *  401 do PC (token), 0 é a rede do celular. */
export function errorText(err: unknown): string {
  const s = statusOf(err)
  if (s === 401) return 'O PC não aceitou o token salvo. Escaneie o QR de novo se a ponte foi reconfigurada.'
  if (s === 409) return 'Outro celular está pareado com este PC.'
  if (s === 503) return 'O PC não está conectado ao servidor remoto (ponte desligada, PC desligado ou sem internet).'
  if (s === 504 || s === 502) return 'O PC não respondeu a tempo. Ele pode ter acabado de dormir ou perder a rede.'
  if (s === 413) return 'Anexo grande demais para enviar pelo celular.'
  if (s) return `Erro HTTP ${s} ao falar com o PC.`
  return 'Sem conexão. Verifique a internet do celular.'
}

export interface ApiAuth {
  base: string
  token: string
  dev: string
  devName: string
}

/** URL de uma rota com token e identidade do aparelho na query (como o GET/SSE). */
export function apiUrl(auth: ApiAuth, path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return (
    auth.base + path + sep + 'token=' + encodeURIComponent(auth.token) +
    '&dev=' + encodeURIComponent(auth.dev) + '&devname=' + encodeURIComponent(auth.devName)
  )
}

export interface FetchOpts {
  method?: 'GET' | 'POST'
  body?: unknown
  timeout?: number
}

/** `fetch` JSON com prazo duro. Rejeita com HttpError (status 0 = rede/prazo). */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? FETCH_TIMEOUT_MS)
  const init: RequestInit = { method: opts.method ?? 'GET', signal: ctrl.signal }
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    clearTimeout(timer)
    throw new HttpError(0)
  }
  clearTimeout(timer)
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      /* corpo não-JSON */
    }
    throw new HttpError(res.status, body)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new HttpError(res.status || 0)
  }
}

/** Sonda rápida com prazo: resolve true/false, nunca rejeita. */
export async function probeReachable(url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Prefere a LAN do PC ao endereço público quando os dois existem e a LAN responde
 * agora (mesma Wi‑Fi) — evita passar tudo (inclusive downloads) pelo relay. Na
 * falha/prazo, ou sem LAN registrada, fica no público. Nunca rejeita.
 */
export async function pickBestBase(
  publicBase: string,
  lan: string,
  token: string,
  probe: (url: string, timeoutMs: number) => Promise<boolean> = probeReachable
): Promise<string> {
  if (!lan) return publicBase
  const lanBase = 'http://' + lan.replace(/\/+$/, '')
  if (lanBase === publicBase) return publicBase
  const ok = await probe(lanBase + '/api/state?token=' + encodeURIComponent(token), 1200)
  return ok ? lanBase : publicBase
}
