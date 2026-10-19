// Envio de push pelo Firebase Cloud Messaging (API HTTP v1).
//
// A chave da conta de serviço só existe aqui, na VPS (variável de ambiente): o PC
// pede o envio pelo WebSocket do relay e nunca vê a chave. Fluxo do Google
// (https://firebase.google.com/docs/cloud-messaging/auth-server): um JWT RS256
// assinado com a chave privada vira um access token OAuth2 (válido ~1 h, guardado
// em memória até perto de vencer) que autoriza `projects/<id>/messages:send`.
//
// Nada aqui loga a chave, o token do aparelho ou o texto do aviso.
import { createSign } from 'node:crypto'

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** Renova o access token este tanto antes de vencer. */
const RENEW_MARGIN_MS = 60_000
const TITLE_MAX = 64
const BODY_MAX = 180

const b64url = (input) => Buffer.from(input).toString('base64url')

/** Lê a conta de serviço (o JSON baixado do console). Inválida → null. */
export function parseServiceAccount(raw) {
  if (!raw) return null
  try {
    const sa = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (sa && typeof sa.client_email === 'string' && typeof sa.private_key === 'string' && typeof sa.project_id === 'string') return sa
  } catch {
    /* JSON quebrado: FCM fica desligado */
  }
  return null
}

function cut(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Só pares texto→texto (exigência do FCM para `data`), com limite de tamanho. */
function cleanData(data) {
  const out = {}
  if (!data || typeof data !== 'object') return out
  for (const [k, v] of Object.entries(data).slice(0, 10)) {
    if (typeof k === 'string' && k.length <= 40 && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 200)
  }
  return out
}

/**
 * @param {{ serviceAccount: object, fetchImpl?: typeof fetch, now?: () => number }} opts
 * @returns {{ send(msg: {token: string, title: string, body: string, data?: object}): Promise<{ok: boolean, status: number, error?: string}> }}
 */
export function createFcm({ serviceAccount, fetchImpl = fetch, now = Date.now }) {
  const sa = serviceAccount
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI
  let cached = null // { token, expiresAt }

  function jwt() {
    const iat = Math.floor(now() / 1000)
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }))
    const signer = createSign('RSA-SHA256')
    signer.update(`${head}.${claims}`)
    return `${head}.${claims}.${signer.sign(sa.private_key).toString('base64url')}`
  }

  async function accessToken() {
    if (cached && now() < cached.expiresAt - RENEW_MARGIN_MS) return cached.token
    const res = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt() }).toString()
    })
    if (!res.ok) throw Object.assign(new Error(`oauth ${res.status}`), { status: res.status })
    const json = await res.json()
    if (!json || typeof json.access_token !== 'string') throw Object.assign(new Error('oauth sem access_token'), { status: 502 })
    cached = { token: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000 }
    return cached.token
  }

  async function send({ token, title, body, data }) {
    let bearer
    try {
      bearer = await accessToken()
    } catch (error) {
      return { ok: false, status: error.status || 0, error: 'oauth' }
    }
    const message = {
      token,
      notification: { title: cut(title, TITLE_MAX), body: cut(body, BODY_MAX) },
      data: cleanData(data),
      android: { priority: 'HIGH', notification: { channel_id: 'avisos' } }
    }
    try {
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message })
      })
      if (res.status === 401) cached = null // token revogado: o próximo envio pede outro
      if (res.ok) return { ok: true, status: res.status }
      let code = ''
      try {
        const err = await res.json()
        code = err?.error?.details?.find?.((d) => d?.errorCode)?.errorCode || err?.error?.status || ''
      } catch {
        /* corpo não-JSON */
      }
      return { ok: false, status: res.status, error: code || 'fcm' }
    } catch {
      return { ok: false, status: 0, error: 'rede' }
    }
  }

  return { send }
}
