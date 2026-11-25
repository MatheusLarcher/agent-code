// agent-code broker — utilitários do canal de suporte (src/suporte.js): comparação
// em tempo constante, limpeza de texto, cabeçalhos, endereço de quem chamou e corpo.
import { createHash, timingSafeEqual } from 'node:crypto'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

export const sha256 = (texto) => createHash('sha256').update(String(texto)).digest()
/** Comparação em tempo constante (os dois lados passam pelo mesmo hash). */
export const igual = (a, b) => timingSafeEqual(sha256(a), sha256(b))
export const limpo = (valor, max) => (typeof valor === 'string' ? valor.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '')

export function filtrar(headers, fora = HOP_BY_HOP) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || fora.has(lk) || v == null) continue
    out[k] = v
  }
  return out
}

export function json(res, status, corpo) {
  try {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(corpo))
  } catch {
    /* cliente foi embora */
  }
}

export function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(obj))
  } catch {
    /* ignore */
  }
}

export function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')
  return m ? m[1] : ''
}

/** O broker fica atrás do Nginx (e do Cloudflare): a conexão vem do proxy, e o
 *  endereço de quem chamou está no cabeçalho. Fora de rede local, vale o socket. */
export function enderecoDe(req) {
  const remoto = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const local = remoto === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remoto) || /^f[cd]/i.test(remoto)
  if (local) {
    const h = req.headers
    const visto = h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0]
    const ip = String(visto || '').trim()
    if (/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return ip
  }
  return remoto || 'desconhecido'
}

export function lerCorpo(req, max) {
  return new Promise((resolve) => {
    const partes = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > max) {
        resolve(null)
        req.destroy()
      } else partes.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(partes)))
    req.on('error', () => resolve(null))
  })
}
