#!/usr/bin/env node
// Troca o claude.exe oficial (que o sync-engine.mjs acabou de instalar) pelo
// CLI recompilado sem as travas do classificador do modo auto — sem elas a
// escolha "Modelo do classificador" das Configurações não passa de Haiku.
// O exe (~188 MB) fica FORA do git; o caminho vem do build-installer.bat.
//
// Modos:
//   node scripts/engine-override.mjs <exe>                 -> copia e confere o hash
//   node scripts/engine-override.mjs <exe> --verify <dir>  -> confere que <dir>
//        (ex.: dist/win-unpacked/resources/app) saiu com o exe modificado
//
// Exe ausente: avisa e sai com 0 (o build segue com o motor oficial).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SDK = '@anthropic-ai/claude-agent-sdk'
const TARGET = join('node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude')

const die = (msg) => {
  console.error(`[motor-livre] ERRO: ${msg}`)
  process.exit(1)
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => ok(hash.digest('hex').toUpperCase())).on('error', fail)
  })
}

function cliVersion(file) {
  try {
    return execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
  } catch {
    return '(nao foi possivel consultar)'
  }
}

function sdkVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', ...SDK.split('/'), 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

async function main() {
  const args = process.argv.slice(2)
  const exe = args[0]
  if (!exe) die('informe o caminho do claude.exe modificado.')
  if (!existsSync(exe)) {
    console.warn(`[motor-livre] AVISO: ${exe} nao existe — o build segue com o claude.exe OFICIAL`)
    console.warn('[motor-livre]        (o classificador do modo auto so aceita Automatico/Haiku 5.5 nele).')
    return
  }
  const esperado = await sha256(exe)

  const iVerify = args.indexOf('--verify')
  if (iVerify !== -1) {
    const dir = args[iVerify + 1]
    if (!dir) die('--verify precisa do caminho do app empacotado.')
    const alvo = join(resolve(ROOT, dir), TARGET)
    if (!existsSync(alvo)) die(`claude.exe nao encontrado em ${alvo}.`)
    const real = await sha256(alvo)
    if (real !== esperado) die(`o instalador saiu com outro claude.exe (${real.slice(0, 12)}…), esperado ${esperado.slice(0, 12)}….`)
    console.log(`[motor-livre] instalador OK: claude.exe modificado embutido (SHA256 ${esperado}).`)
    return
  }

  const destino = join(ROOT, TARGET)
  if (!existsSync(destino)) die(`${destino} nao existe — rode o sync-engine.mjs antes.`)
  copyFileSync(exe, destino)
  const copiado = await sha256(destino)
  if (copiado !== esperado) die(`hash diferente apos copiar: ${copiado} != ${esperado}.`)
  console.log(`[motor-livre] claude.exe modificado aplicado (SHA256 ${esperado}).`)
  console.log(`[motor-livre] SDK ${sdkVersion()} | claude --version do modificado: ${cliVersion(destino)}`)
  console.log('[motor-livre] Se o SDK subiu de versao, o exe modificado continua na dele ate ser recompilado.')
}

main().catch((err) => die(err?.message ?? String(err)))
