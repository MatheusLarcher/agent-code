#!/usr/bin/env node
/*
 * Ponte de teste do app do celular: sobe o RemoteServer REAL (src/main/remote/
 * remoteServer.ts) com um estado simulado — conversas, Central, pedidos de
 * permissão, streaming do agente — sem tocar no app do PC nem nas conversas de
 * verdade. Serve também o cliente em /app (smartfone-remote/www).
 *
 *   node scripts/phone/dev-bridge.mjs            # token "devtoken"
 *   PHONE_DEV_TOKEN=xyz node scripts/phone/dev-bridge.mjs
 *
 * Controle (simular eventos) em http://127.0.0.1:8799/ctl/<ação> — veja devBridge.ts.
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(mkdtempSync(join(tmpdir(), 'phone-dev-bridge-')), 'bridge.mjs')
await build({
  entryPoints: [join(here, 'devBridge.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  logLevel: 'warning'
})
await import(pathToFileURL(out).href)
