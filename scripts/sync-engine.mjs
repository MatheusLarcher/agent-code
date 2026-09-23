#!/usr/bin/env node
// Garante que o "motor" do Agent Code — o Claude Code CLI que vem dentro do
// @anthropic-ai/claude-agent-sdk — esteja na ULTIMA versao antes do build e que
// ele realmente entre no instalador. Sem isso, o exe podia sair com um motor
// antigo (ou depender do que estivesse instalado na maquina).
//
// Modos:
//   node scripts/sync-engine.mjs            -> atualiza para @latest e valida
//   node scripts/sync-engine.mjs --check    -> so valida o que ja esta instalado
//   node scripts/sync-engine.mjs --verify <dir>
//        -> confere que <dir> (ex.: dist/win-unpacked/resources/app) tem o SDK
//           na mesma versao do repositorio, com o binario do CLI dentro.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SDK = '@anthropic-ai/claude-agent-sdk'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const die = (msg) => {
  console.error(`[motor] ERRO: ${msg}`)
  process.exit(1)
}

/** Pacote por plataforma que carrega o binario do CLI. */
function platformPkg(plat = process.platform, arch = process.arch) {
  return `${SDK}-${plat}-${arch}`
}

function binName(plat = process.platform) {
  return plat === 'win32' ? 'claude.exe' : 'claude'
}

/** Versao do SDK instalada em <base>/node_modules, ou '' se nao houver. */
function installedVersion(base) {
  const pkg = join(base, 'node_modules', ...SDK.split('/'), 'package.json')
  if (!existsSync(pkg)) return ''
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

/** Faixa declarada em dependencies do package.json do repositorio. */
function declaredSpec() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return pkg.dependencies?.[SDK] ?? ''
  } catch {
    return ''
  }
}

/** Caminho do binario do CLI dentro de <base>, ou '' se nao houver. */
function cliPath(base) {
  const p = join(base, 'node_modules', ...platformPkg().split('/'), binName())
  return existsSync(p) ? p : ''
}

// Via shell: no Windows o Node nao executa npm.cmd com execFileSync direto.
// Os argumentos aqui sao todos literais do proprio script (nada vem de fora).
function run(args, opts = {}) {
  return execSync(`${NPM} ${args.join(' ')}`, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    ...opts
  })
}

function update() {
  let latest = ''
  try {
    latest = run(['view', SDK, 'version']).trim()
  } catch (err) {
    console.warn(`[motor] npm view falhou (sem rede?): ${err?.message ?? err}`)
    console.warn('[motor] seguindo com a versao local.')
  }
  const atual = installedVersion(ROOT)
  if (!latest) {
    if (!atual) die(`${SDK} nao esta instalado e nao foi possivel consultar o npm.`)
    console.log(`[motor] mantendo a versao instalada ${atual}.`)
    return
  }
  const declarado = declaredSpec()
  if (atual === latest && declarado === latest) {
    console.log(`[motor] ja esta na ultima versao (${latest}).`)
    return
  }
  console.log(`[motor] atualizando ${SDK}: ${atual || '(ausente)'} -> ${latest}`)
  // --save-exact: o motor fica pregado no package.json, sem "^". Assim a
  // mesma versao vale em toda maquina e dentro do instalador.
  run(['install', `${SDK}@${latest}`, '--save-exact', '--no-audit', '--no-fund'], { stdio: 'inherit' })
  const depois = installedVersion(ROOT)
  if (depois !== latest) die(`apos o npm install a versao instalada e ${depois || '(ausente)'}, esperado ${latest}.`)
}

function check(base, rotulo) {
  const v = installedVersion(base)
  if (!v) die(`${SDK} nao encontrado em ${rotulo}.`)
  const cli = cliPath(base)
  if (!cli) die(`${platformPkg()}/${binName()} nao encontrado em ${rotulo} — o instalador sairia sem o motor.`)
  return { v, cli }
}

function main() {
  const args = process.argv.slice(2)
  const iVerify = args.indexOf('--verify')

  if (iVerify !== -1) {
    const dir = args[iVerify + 1]
    if (!dir) die('--verify precisa do caminho do app empacotado.')
    const alvo = resolve(ROOT, dir)
    if (!existsSync(alvo)) die(`pasta do app empacotado nao existe: ${alvo}`)
    const esperado = installedVersion(ROOT)
    const { v, cli } = check(alvo, alvo)
    if (v !== esperado) die(`o instalador ficou com o motor ${v}, mas o repositorio usa ${esperado}.`)
    console.log(`[motor] instalador OK: ${SDK} ${v} com ${binName()} embutido (${cli}).`)
    return
  }

  if (!args.includes('--check')) update()

  const { v, cli } = check(ROOT, 'node_modules do repositorio')
  let versaoCli = ''
  try {
    versaoCli = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
  } catch {
    versaoCli = '(nao foi possivel consultar)'
  }
  console.log(`[motor] SDK ${v} | claude --version: ${versaoCli}`)
  console.log(`[motor] binario: ${cli}`)
}

main()
