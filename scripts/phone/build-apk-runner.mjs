#!/usr/bin/env node
/*
 * Gera o APK do Agent Remote com o MESMO código do botão "Gerar APK" do app
 * (src/main/remote/buildApk.ts), fora do Electron: bundla o módulo com o esbuild
 * da raiz num arquivo temporário e chama buildRemoteApk(smartfone-remote).
 *
 * Uso (na raiz do repositório):
 *   node scripts/phone/build-apk-runner.mjs
 *
 * O toolchain (JDK 17/21, Android SDK) é o que o app instala: AGENT_CODE_HOME
 * aponta para o userData dele (%APPDATA%\agent-code-desktop no Windows) quando
 * não está definido. Saída: smartfone-remote/dist/agent-remote.apk.
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function appUserData() {
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'agent-code-desktop')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'agent-code-desktop')
  return join(homedir(), '.config', 'agent-code-desktop')
}
process.env.AGENT_CODE_HOME ||= appUserData()

const out = mkdtempSync(join(tmpdir(), 'apk-runner-'))
const bundle = join(out, 'buildApk.mjs')
try {
  await build({
    entryPoints: [join(REPO, 'src', 'main', 'remote', 'buildApk.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Fora do Electron o import('electron') do androidEnv falha e ele usa AGENT_CODE_HOME.
    external: ['electron'],
    outfile: bundle,
    logLevel: 'warning'
  })
  const { buildRemoteApk } = await import(pathToFileURL(bundle).href)
  const r = await buildRemoteApk(join(REPO, 'smartfone-remote'), (line) => console.log(line))
  console.log(r.ok ? `OK: ${r.message}` : `FALHOU: ${r.message}`)
  process.exitCode = r.ok ? 0 : 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
