#!/usr/bin/env node
/*
 * Ponta a ponta do aviso no celular com o código de verdade, fora do Electron:
 * regra de destino (PC parado → celular) → EntregaAvisos → RelayClient → broker
 * (createBroker + FCM v1 com a conta de serviço) → Firebase → aparelho.
 *
 * Uso (na raiz do repositório):
 *   FCM_SERVICE_ACCOUNT_FILE=<cofre>\agent-code-firebase-service-account.json \
 *     node scripts/phone/push-e2e.mjs <arquivo-com-o-token-fcm> [ocioso-segundos]
 *
 * O token do aparelho vem de arquivo (não vai para a linha de comando nem para o
 * log); a chave fica no cofre. Imprime a linha do broker ("push FCM 200") e se o
 * aviso caiu no Windows.
 */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBroker } from '../../broker/src/broker.js'
import { createFcm, parseServiceAccount } from '../../broker/src/fcm.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [tokenFile, ociosoArg] = process.argv.slice(2)
if (!tokenFile || !process.env.FCM_SERVICE_ACCOUNT_FILE) {
  console.error('uso: FCM_SERVICE_ACCOUNT_FILE=<json> node scripts/phone/push-e2e.mjs <token.txt> [ocioso-segundos]')
  process.exit(2)
}
const serviceAccount = parseServiceAccount(readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'))
if (!serviceAccount) throw new Error('conta de serviço inválida')
const deviceToken = readFileSync(tokenFile, 'utf8').trim()
const ocioso = Number(ociosoArg ?? 600)

// Dentro de node_modules/.cache: o bundle resolve o 'ws' do repositório.
const cache = join(REPO, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const out = mkdtempSync(join(cache, 'push-e2e-'))
try {
  const entry = join(out, 'entry.ts')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(entry, [
    `export { RelayClient } from ${JSON.stringify(join(REPO, 'src/main/remote/relayClient.ts'))}`,
    `export { ligarAvisoCelular } from ${JSON.stringify(join(REPO, 'src/main/tarefas/destinoCelular.ts'))}`,
    `export { EntregaAvisos } from ${JSON.stringify(join(REPO, 'src/main/tarefas/entrega.ts'))}`
  ].join('\n'))
  const bundle = join(out, 'pc.mjs')
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, external: ['ws'], logLevel: 'error', nodePaths: [join(REPO, 'node_modules')] })
  const { RelayClient, ligarAvisoCelular, EntregaAvisos } = await import(pathToFileURL(bundle).href)

  const brokerLog = []
  const broker = createBroker({ fcm: createFcm({ serviceAccount }), log: (l) => brokerLog.push(l) })
  await new Promise((r) => broker.listen(0, r))
  const relay = new RelayClient({ brokerUrl: `ws://127.0.0.1:${broker.server.address().port}/__relay`, getToken: () => 'pc-e2e', getPort: () => 1 })
  relay.start()
  for (let i = 0; i < 100 && !relay.isConnected(); i++) await new Promise((r) => setTimeout(r, 50))
  if (!relay.isConnected()) throw new Error('relay não conectou ao broker')

  const pcLog = []
  const windows = []
  const ligado = ligarAvisoCelular({
    pairing: { pushToken: () => deviceToken, setPushToken: () => true },
    push: (req) => relay.push(req),
    powerMonitor: { getSystemIdleTime: () => ocioso, on: () => undefined },
    handle: () => undefined,
    log: (l) => pcLog.push(l)
  })
  const entrega = new EntregaAvisos({
    suportado: () => true,
    criar: (o) => (windows.push(o.title), { on: () => undefined, show: () => undefined }),
    abrir: () => undefined,
    log: (l) => pcLog.push(l),
    ...ligado
  })
  entrega.entregar({ tipo: 'lembrete', convId: 'e2e-conv', tarefaId: 'e2e', titulo: 'Lembrete · teste do push', texto: `Enviado às ${new Date().toLocaleTimeString('pt-BR')} pelo broker.` })
  for (let i = 0; i < 200 && !brokerLog.length && !windows.length; i++) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 300))
  console.log(`PC ocioso ${ocioso}s → ${windows.length ? 'Windows' : 'celular'}`)
  for (const l of brokerLog) console.log(l)
  for (const l of pcLog) console.log(l)
  relay.stop()
  await broker.close()
} finally {
  rmSync(out, { recursive: true, force: true })
}
