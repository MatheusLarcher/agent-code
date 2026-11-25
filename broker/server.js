// Entrypoint do broker. Configuração por env (.env dev / .env-prod na VPS).
import { readFileSync } from 'node:fs'
import { createBroker } from './src/broker.js'
import { createFcm, parseServiceAccount } from './src/fcm.js'
import { createSuporte } from './src/suporte.js'

const PORT = Number(process.env.PORT || 8099)
const RELAY_KEY = process.env.RELAY_KEY || ''
// Chave da equipe do suporte remoto. Sem ela, o canal de suporte inteiro recusa.
const SUPORTE_KEY = process.env.SUPORTE_KEY || ''

// Conta de serviço do Firebase (push no celular): o JSON inteiro em
// FCM_SERVICE_ACCOUNT, ou o caminho dele em FCM_SERVICE_ACCOUNT_FILE. Só na VPS.
function loadServiceAccount() {
  if (process.env.FCM_SERVICE_ACCOUNT) return parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT)
  if (process.env.FCM_SERVICE_ACCOUNT_FILE) {
    try {
      return parseServiceAccount(readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'))
    } catch {
      return null
    }
  }
  return null
}

const serviceAccount = loadServiceAccount()
const fcm = serviceAccount ? createFcm({ serviceAccount }) : null

const log = (line) => console.log(line)
const suporte = createSuporte({ chave: SUPORTE_KEY, log })
const broker = createBroker({ relayKey: RELAY_KEY, fcm, log, suporte })
broker.listen(PORT, () => {
  const extras = [RELAY_KEY ? 'relayKey ligado' : '', fcm ? 'push FCM ligado' : 'push FCM desligado', SUPORTE_KEY ? 'suporte ligado' : 'suporte desligado'].filter(Boolean).join(', ')
  console.log(`[broker] ouvindo em :${PORT} (${extras})`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[broker] ${sig} — encerrando`)
    broker.close().then(() => process.exit(0))
  })
}
