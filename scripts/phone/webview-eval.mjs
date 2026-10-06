#!/usr/bin/env node
/*
 * Avalia JavaScript no WebView do Agent Remote instalado (APK debug) pelo
 * DevTools remoto: adb forward → /json → Runtime.evaluate. Para validar no
 * emulador o que a câmera não alcança (o AVD usa câmera "emulated", que não lê
 * QR): o `--pair` faz o que o QR faria (`client.addPc`) — adiciona uma filial à
 * lista `agent-remote-pcs` (token já salvo: só atualiza o endereço) e a ativa,
 * espelha em `agent-remote-config`, deixa o sinal de uso único
 * `agent-remote-pending` (a próxima carga faz o POST /api/pair) e recarrega.
 *
 *   node scripts/phone/webview-eval.mjs "document.title"
 *   node scripts/phone/webview-eval.mjs --pair http://10.0.2.2:8765 devtoken
 *
 * Usa o adb do SDK do app (ANDROID_HOME ou %APPDATA%\agent-code-desktop\android-sdk).
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import WebSocket from 'ws'

const PKG = 'com.matheus.agentremote'
const PORT = 9333
const sdk = process.env.ANDROID_HOME || join(process.env.APPDATA || '', 'agent-code-desktop', 'android-sdk')
const adb = (...args) => execFileSync(join(sdk, 'platform-tools', 'adb.exe'), args, { encoding: 'utf8', timeout: 15000 })

const pid = adb('shell', 'pidof', PKG).trim()
if (!pid) throw new Error(`${PKG} não está rodando`)
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`)
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page')
if (!page) throw new Error('nenhuma página no WebView')

let expr = process.argv[2] ?? 'location.href'
if (expr === '--pair') {
  const [base, token] = process.argv.slice(3)
  if (!base || !token) throw new Error('uso: --pair <base> <token>') // como o addPc, que ignora QR sem endereço ou sem token
  // Uma expressão só (função imediata: nada vaza para o escopo global do WebView) que repete, pelo localStorage,
  // o que o app faz em pcs.ts: upsertPc (por token) + setActivePc + setPendingSwitch. Sem imports: roda dentro da página.
  expr = `((base, token) => {
    const now = Date.now()
    let list = null
    try { list = JSON.parse(localStorage.getItem('agent-remote-pcs')) } catch {}
    if (!list || !Array.isArray(list.pcs)) list = { pcs: [], activeId: null }
    let pc = list.pcs.find((p) => p?.token === token)
    if (pc) Object.assign(pc, { base, lan: '' })
    else list.pcs.push((pc = { id: 'pc-' + Math.random().toString(36).slice(2, 10) + now.toString(36), nome: null, base, token, lan: '', lastConv: null, addedAt: now, lastUsedAt: now }))
    pc.lastUsedAt = now
    list.activeId = pc.id
    localStorage.setItem('agent-remote-pcs', JSON.stringify(list))
    localStorage.setItem('agent-remote-config', JSON.stringify({ base, token, lan: '' }))
    localStorage.setItem('agent-remote-pending', JSON.stringify({ pcId: pc.id, explicit: true, notices: [] }))
    location.reload()
    return 'pareado'
  })(${JSON.stringify(base)}, ${JSON.stringify(token)})`
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
const reply = await new Promise((r) => ws.once('message', (m) => r(JSON.parse(String(m)))))
ws.close()
const res = reply.result?.result
console.log(res?.type === 'string' ? res.value : JSON.stringify(res?.value ?? reply.result))
