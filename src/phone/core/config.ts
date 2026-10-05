/**
 * Pareamento salvo no aparelho e a identidade deste celular.
 *
 * As chaves do localStorage são as MESMAS do app antigo (www/app.js): o APK novo
 * substitui o antigo com o mesmo appId e a mesma origem (http://localhost), então
 * quem atualiza continua pareado e com o mesmo id de aparelho — um id novo faria
 * o PC responder 409 ("outro celular") para o próprio dono.
 */

export const CONFIG_KEY = 'agent-remote-config'
export const LAST_CONV_KEY = 'agent-remote-last-conv'
export const DEVICE_KEY = 'agent-remote-device'

export interface PairConfig {
  /** Origem pública (VPS/relay) ou, num QR antigo, a da LAN. */
  base: string
  token: string
  /** `ip:porta` do PC na LAN (`?lan=` do QR), quando veio. */
  lan: string
}

/**
 * O conteúdo do QR → endereço, token e LAN. O QR é a URL pública
 * `https://host/?token=…&lan=ip:porta`; um QR antigo traz só a URL da LAN.
 */
export function parseConfig(addr: string, token = ''): PairConfig {
  const a = (addr || '').trim()
  let t = (token || '').trim()
  let base = ''
  let lan = ''
  if (/^https?:\/\//i.test(a)) {
    try {
      const u = new URL(a)
      base = `${u.protocol}//${u.host}`
      if (!t) t = u.searchParams.get('token') ?? ''
      lan = u.searchParams.get('lan') ?? ''
    } catch {
      /* URL inválida: sem endereço */
    }
  }
  return { base, token: t, lan }
}

export function loadConfig(): PairConfig | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') as Partial<PairConfig> | null
    if (!raw || typeof raw.base !== 'string' || typeof raw.token !== 'string') return null
    return { base: raw.base, token: raw.token, lan: typeof raw.lan === 'string' ? raw.lan : '' }
  } catch {
    return null
  }
}

export function saveConfig(cfg: PairConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

export function clearConfig(): void {
  localStorage.removeItem(CONFIG_KEY)
}

/**
 * No navegador, aberto pela ponte em `/app/?token=…` (link da página do PC): o
 * próprio endereço é a ponte. Substitui o antigo "inserir endereço manualmente",
 * que saiu — no APK o pareamento é só pelo QR.
 */
export function configFromLocation(loc: Pick<Location, 'protocol' | 'host' | 'search'>): PairConfig | null {
  if (!/^https?:$/.test(loc.protocol)) return null
  const token = new URLSearchParams(loc.search).get('token') ?? ''
  if (!token || /^localhost(:\d+)?$/i.test(loc.host)) return null
  return { base: `${loc.protocol}//${loc.host}`, token, lan: '' }
}

/** Identidade estável deste celular (1 celular por PC — o PC compara este id). */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = 'ph-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

/** Nome legível do aparelho para o PC ("Outro celular pareado: <nome>"). */
export function deviceName(ua = navigator.userAgent || ''): string {
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua)
  if (m && m[1] && !/^[a-z]{2}-[a-z]{2}$/i.test(m[1].trim())) return m[1].trim().slice(0, 40)
  if (/iPhone/.test(ua)) return 'iPhone'
  return 'celular'
}

export function loadLastConv(): string | null {
  return localStorage.getItem(LAST_CONV_KEY)
}

export function saveLastConv(convId: string): void {
  localStorage.setItem(LAST_CONV_KEY, convId)
}
