#!/usr/bin/env node
// Troca o claude.exe oficial (que o sync-engine.mjs acabou de instalar) pelo
// CLI recompilado sem as travas do classificador do modo auto — sem elas a
// escolha "Modelo do classificador" das Configurações não passa de Haiku.
// O exe (~188 MB) fica FORA do git (passa do limite do GitHub): mora na pasta
// de cache do app (<cacheDir>/motor/claude-classificador-livre.exe), que o
// OneDrive sincroniza entre as máquinas. CLAUDE_EXE_LIVRE sobrepõe o caminho.
//
// Modos:
//   node scripts/engine-override.mjs                 -> copia e confere o hash
//   node scripts/engine-override.mjs --verify <dir>  -> confere que <dir>
//        (ex.: dist/win-unpacked/resources/app) saiu com o exe modificado
//
// Exe ausente: ERRO (o setup não pode sair com o motor oficial calado).
// AGENT_CODE_MOTOR_OFICIAL=1 libera o build com o oficial (máquina sem o exe).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

// Mesmo ponteiro que o app e o stage-skills.mjs usam para achar a pasta de cache.
function exeLivrePath() {
  if (process.env.CLAUDE_EXE_LIVRE) return process.env.CLAUDE_EXE_LIVRE
  try {
    const { cacheDir } = JSON.parse(readFileSync(join(homedir(), '.agent-code', 'location.json'), 'utf8'))
    if (typeof cacheDir === 'string' && cacheDir) return join(cacheDir, 'motor', 'claude-classificador-livre.exe')
  } catch {
    // sem ponteiro: o app nunca rodou nesta máquina
  }
  return ''
}

async function main() {
  const args = process.argv.slice(2)
  const exe = exeLivrePath()
  if (!exe || !existsSync(exe)) {
    const onde = exe || '(sem ~/.agent-code/location.json nem CLAUDE_EXE_LIVRE)'
    if (process.env.AGENT_CODE_MOTOR_OFICIAL === '1') {
      console.warn(`[motor-livre] AVISO: ${onde} nao existe — AGENT_CODE_MOTOR_OFICIAL=1, segue com o claude.exe OFICIAL.`)
      return
    }
    die(`claude.exe modificado nao encontrado: ${onde}\n` +
      '[motor-livre] Espere o OneDrive sincronizar a pasta motor\\, ou aponte CLAUDE_EXE_LIVRE para o exe.\n' +
      '[motor-livre] Para gerar mesmo assim com o motor oficial: set AGENT_CODE_MOTOR_OFICIAL=1')
  }
  console.log(`[motor-livre] exe: ${exe}`)
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
