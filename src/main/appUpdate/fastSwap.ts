// Atualização rápida: o instalador NSIS levava ~6 min (copia 1,7 GB / 14,6 mil
// arquivos para a pasta temporária, renomeia a pasta velha arquivo por arquivo,
// copia tudo de novo para a pasta do app e apaga as sobras — sob o antivírus).
//
// Aqui o trabalho pesado sai do momento do clique: assim que o setup baixa, o
// app abre o AgentCode-setup.exe como 7z (o pacote do app vai dentro dele sem
// compressão do NSIS) e extrai a versão nova numa pasta IRMÃ da instalação, em
// segundo plano e com prioridade baixa. No "Atualizar agora", depois do
// fechamento ordenado, um script destacado espera o app sair, troca as duas
// pastas por renomeação (instantâneo, mesmo disco), acerta a versão no registro
// de desinstalação e reabre o app. Qualquer falha na troca desfaz a renomeação e
// cai no instalador NSIS de sempre (`--updated /S --force-run`).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import { constants as osConstants, setPriority } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Pasta com a versão nova extraída (irmã da instalação: a troca é um rename no mesmo disco). */
export function stagedDirFor(installDir: string, version: string): string {
  return `${installDir}.next-${version}`
}
const partialDirFor = (installDir: string, version: string): string => `${stagedDirFor(installDir, version)}.part`
export const oldDirFor = (installDir: string): string => `${installDir}.old`

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** A pasta extraída é desta versão e tem o executável? (o que a troca exige) */
export function isStagedReady(stagedDir: string, exeName: string, version: string): boolean {
  try {
    if (!existsSync(join(stagedDir, exeName))) return false
    const pkg = JSON.parse(readFileSync(join(stagedDir, 'resources', 'app', 'package.json'), 'utf8')) as { version?: unknown }
    return pkg.version === version
  } catch {
    return false
  }
}

export type SevenZipRunner = (sevenZip: string, args: string[]) => Promise<number>

/** Roda o 7za com prioridade abaixo do normal (o app continua leve) e devolve o código de saída. */
export function runSevenZip(sevenZip: string, args: string[], timeoutMs = 20 * 60_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`7za não terminou em ${Math.round(timeoutMs / 60_000)} min`))
    }, timeoutMs)
    timer.unref?.()
    try {
      if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      /* prioridade é só gentileza */
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (err = (err + chunk).slice(-2000)))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === 1) resolve(code)
      else reject(new Error(`7za saiu com código ${code}: ${err.replace(/\s+/g, ' ').trim().slice(0, 300)}`))
    })
  })
}

export interface StagerDeps {
  log: (line: string) => void
  installDir: string
  exeName: string
  /** resources/7zip/7za.exe; null = build sem 7-Zip (só o instalador NSIS). */
  sevenZip: string | null
  run?: SevenZipRunner
}

/** Extrai a versão baixada para a pasta irmã. Uma extração por vez; repetir a mesma versão é grátis. */
export class FastUpdateStager {
  private current: Promise<boolean> | null = null
  private currentVersion: string | null = null

  constructor(private readonly deps: StagerDeps) {}

  /** A pasta pronta para a troca, ou null (ainda extraindo, falhou, ou outra versão). */
  readyDir(version: string | null): string | null {
    if (!version || !VERSION_RE.test(version)) return null
    const dir = stagedDirFor(this.deps.installDir, version)
    return isStagedReady(dir, this.deps.exeName, version) ? dir : null
  }

  stage(setupFile: string, version: string): Promise<boolean> {
    if (this.current && this.currentVersion === version) return this.current
    const job = this.extract(setupFile, version).catch((error: unknown) => {
      this.deps.log(`atualização rápida: extração da ${version} falhou (${error instanceof Error ? error.message : String(error)}); o clique usa o instalador normal`)
      // A próxima chamada (checagem de hora em hora ou o clique) tenta de novo.
      if (this.current === job) this.current = null
      return false
    })
    this.current = job
    this.currentVersion = version
    return job
  }

  private async extract(setupFile: string, version: string): Promise<boolean> {
    const { deps } = this
    if (!VERSION_RE.test(version)) throw new Error(`versão inválida: ${version}`)
    if (!deps.sevenZip || !existsSync(deps.sevenZip)) {
      deps.log('atualização rápida indisponível: 7-Zip não veio nesta build; o clique usa o instalador normal')
      return false
    }
    const target = stagedDirFor(deps.installDir, version)
    if (isStagedReady(target, deps.exeName, version)) {
      deps.log(`atualização rápida: ${version} já extraída em ${target}`)
      return true
    }
    this.cleanSiblings(version)
    const partial = partialDirFor(deps.installDir, version)
    rmSync(partial, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    const started = Date.now()
    deps.log(`atualização rápida: extraindo a ${version} em segundo plano para ${target}`)
    await (deps.run ?? runSevenZip)(deps.sevenZip, ['x', setupFile, `-o${partial}`, '-y', '-bso0', '-bsp0'])
    if (!isStagedReady(partial, deps.exeName, version)) {
      rmSync(partial, { recursive: true, force: true })
      throw new Error('a pasta extraída não tem o executável ou a versão esperada')
    }
    renameSync(partial, target)
    deps.log(`atualização rápida: ${version} extraída em ${Math.round((Date.now() - started) / 1000)} s; o clique só troca as pastas`)
    return true
  }

  /** Extrações de outras versões e sobras de trocas antigas: só ocupam disco. */
  private cleanSiblings(keepVersion: string): void {
    const { installDir } = this.deps
    const parent = dirname(installDir)
    const base = basename(installDir).toLowerCase()
    const keep = basename(stagedDirFor(installDir, keepVersion)).toLowerCase()
    let names: string[] = []
    try {
      names = readdirSync(parent)
    } catch {
      return
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      const leftover = lower === `${base}.old` || (lower.startsWith(`${base}.next-`) && lower !== keep && lower !== `${keep}.part`)
      if (!leftover) continue
      try {
        rmSync(join(parent, name), { recursive: true, force: true })
        this.deps.log(`atualização rápida: sobra removida ${name}`)
      } catch {
        /* fica para a próxima */
      }
    }
  }
}

export interface SwapRequest {
  appPid: number
  installDir: string
  stagedDir: string
  exeName: string
  version: string
  /** O setup baixado: o plano B se a troca não der. */
  setupFile: string
  logFile: string
}

/** Literal de PowerShell entre aspas simples (a única coisa a escapar é a própria aspa). */
const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * O script que roda depois que o app sai, com os valores embutidos no topo (a linha de
 * comando leva só o caminho do script). O arquivo é gravado com BOM: o PowerShell 5.1
 * lê script sem BOM como ANSI e estragaria os acentos do log e dos caminhos.
 */
export function buildSwapScript(request: SwapRequest): string {
  if (!Number.isInteger(request.appPid) || request.appPid <= 0) throw new Error(`PID inválido: ${request.appPid}`)
  if (!VERSION_RE.test(request.version)) throw new Error(`versão inválida: ${request.version}`)
  const header = [
    `$AppPid = ${request.appPid}`,
    `$InstallDir = ${psLiteral(request.installDir)}`,
    `$StagedDir = ${psLiteral(request.stagedDir)}`,
    `$ExeName = ${psLiteral(request.exeName)}`,
    `$Version = ${psLiteral(request.version)}`,
    `$SetupFile = ${psLiteral(request.setupFile)}`,
    `$LogFile = ${psLiteral(request.logFile)}`
  ].join('\r\n')
  return `${header}\r\n${SWAP_SCRIPT_BODY}`
}

const SWAP_SCRIPT_BODY = String.raw`$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
function Log([string]$m) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  try { [IO.File]::AppendAllText($LogFile, "[$stamp] troca: $m" + [char]10, $utf8) } catch {}
}
function Fallback([string]$why) {
  Log "$why; usando o instalador normal"
  try { Start-Process -FilePath $SetupFile -ArgumentList '--updated','/S','--force-run' } catch { Log "o instalador não subiu: $($_.Exception.Message)" }
  exit 1
}
$sw = [Diagnostics.Stopwatch]::StartNew()
$OldDir = "$InstallDir.old"
$prefix = ($InstallDir.TrimEnd('\') + '\').ToLowerInvariant()
try { Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
for ($i = 0; $i -lt 40; $i++) {
  $alive = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLowerInvariant().StartsWith($prefix) })
  if ($alive.Count -eq 0) { break }
  if ($i -eq 20) { $alive | ForEach-Object { Log "encerrando à força $($_.Id) ($($_.Path))"; try { Stop-Process -Id $_.Id -Force } catch {} } }
  Start-Sleep -Milliseconds 250
}
Log "app fechado em $([int]$sw.ElapsedMilliseconds) ms"
if (-not (Test-Path -LiteralPath (Join-Path $StagedDir $ExeName))) { Fallback "pasta extraída sumiu ($StagedDir)" }
if (Test-Path -LiteralPath $OldDir) { try { Remove-Item -LiteralPath $OldDir -Recurse -Force } catch { Fallback "sobra antiga $OldDir não sai" } }
$moved = $false
for ($i = 0; $i -lt 40 -and -not $moved; $i++) {
  try { Rename-Item -LiteralPath $InstallDir -NewName (Split-Path $OldDir -Leaf); $moved = $true } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $moved) { Fallback "a pasta do app continua em uso" }
try {
  Rename-Item -LiteralPath $StagedDir -NewName (Split-Path $InstallDir -Leaf)
} catch {
  Log "não deu para pôr a versão nova no lugar: $($_.Exception.Message); voltando a pasta antiga"
  try { Rename-Item -LiteralPath $OldDir -NewName (Split-Path $InstallDir -Leaf) } catch { Log "a volta também falhou: $($_.Exception.Message)" }
  Fallback "troca desfeita"
}
foreach ($f in @('Uninstall Agent Code.exe', 'uninstallerIcon.ico')) {
  $src = Join-Path $OldDir $f
  if (Test-Path -LiteralPath $src) { try { Copy-Item -LiteralPath $src -Destination (Join-Path $InstallDir $f) -Force } catch { Log "não copiou $f" } }
}
try {
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    if ($p.UninstallString -and $p.UninstallString.ToLowerInvariant().Contains($prefix)) {
      Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version
      Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayName -Value "Agent Code $Version"
    }
  }
} catch { Log "registro de desinstalação não atualizado: $($_.Exception.Message)" }
try { Start-Process -FilePath (Join-Path $InstallDir $ExeName) -WorkingDirectory $InstallDir } catch { Log "o app novo não abriu: $($_.Exception.Message)" }
Log "versão $Version no lugar e app reaberto em $([int]$sw.ElapsedMilliseconds) ms"
try { Remove-Item -LiteralPath $OldDir -Recurse -Force; Log "pasta antiga apagada" } catch { Log "pasta antiga fica para a próxima: $($_.Exception.Message)" }
exit 0
`

/** O que o cmd.exe interpreta mesmo entre aspas: caminho com isto não vai na linha de comando. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/

/** A linha do `cmd /s /c`: o cmd tira só as aspas de fora e o `start /b` sobe o PowerShell. */
export function swapCommandLine(script: string): string {
  if (CMD_UNSAFE.test(script)) throw new Error(`caminho do script com caractere que o cmd interpreta: ${script}`)
  return `/d /s /c "start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}""`
}

/**
 * Grava o script na pasta temporária e sobe; ele espera o app sair. Pelo `cmd /c start`
 * de propósito: `powershell.exe` com `detached: true` (sem console) sai na hora sem rodar
 * nada nesta máquina, e sem `detached` morre junto com o pai — medido em 27/10/2026.
 */
export function launchSwap(request: SwapRequest, tempDir: string): string {
  const script = join(tempDir, `agent-code-troca-${request.version}-${Date.now()}.ps1`)
  const commandLine = swapCommandLine(script)
  writeFileSync(script, `﻿${buildSwapScript(request)}`, 'utf8')
  // cwd fora da instalação: pasta que é diretório atual de um processo não renomeia.
  const child = spawn('cmd.exe', [commandLine], {
    cwd: tempDir, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true
  })
  child.on('error', () => undefined)
  child.unref()
  return script
}
