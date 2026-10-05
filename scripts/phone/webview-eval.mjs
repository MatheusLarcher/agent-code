#!/usr/bin/env node
/*
 * Avalia JavaScript no WebView do Agent Remote instalado (APK debug) pelo
 * DevTools remoto: adb forward → /json → Runtime.evaluate. Para validar no
 * emulador o que a câmera não alcança (o AVD usa câmera "emulated", que não lê
 * QR): por exemplo, gravar o mesmo pareamento que o QR geraria e recarregar.
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
  const cfg = { base: process.argv[3], token: process.argv[4], lan: '' }
  expr = `localStorage.setItem('agent-remote-config', ${JSON.stringify(JSON.stringify(cfg))}); location.reload(); 'pareado'`
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
const reply = await new Promise((r) => ws.once('message', (m) => r(JSON.parse(String(m)))))
ws.close()
const res = reply.result?.result
console.log(res?.type === 'string' ? res.value : JSON.stringify(res?.value ?? reply.result))
