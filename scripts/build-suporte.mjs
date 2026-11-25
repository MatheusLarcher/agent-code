// Publica o exe do cliente do suporte remoto: um arquivo só, com o .NET junto, em
// dist/AgentCode-Suporte.exe. Não faz parte do setup do Agent Code.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('Suporte remoto: build ignorado fora do Windows.')
  process.exit(0)
}

const LIMITE_MB = 80
const root = resolve(import.meta.dirname, '..')
const project = resolve(root, 'src/suporte/AgentCode.Suporte.csproj')
const stage = resolve(root, 'out/suporte')
const destino = resolve(root, 'dist/AgentCode-Suporte.exe')

rmSync(stage, { recursive: true, force: true })
// InvariantGlobalization fica de fora de propósito: com ela o WPF não desenha texto.
const args = [
  'publish', project,
  '--configuration', 'Release',
  '--runtime', 'win-x64',
  '--self-contained', 'true',
  '--output', stage,
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:EnableCompressionInSingleFile=true',
  '-p:SatelliteResourceLanguages=en',
  '-p:DebugType=None',
  '-p:DebugSymbols=false'
]

const run = spawnSync('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true })
if (run.error) {
  console.error('Não foi possível iniciar o SDK .NET. Instale o .NET SDK 8+ para compilar o exe do suporte.')
  console.error(run.error.message)
  process.exit(1)
}
if (run.status !== 0) process.exit(run.status ?? 1)

mkdirSync(resolve(root, 'dist'), { recursive: true })
copyFileSync(resolve(stage, 'AgentCode.Suporte.exe'), destino)
const mb = statSync(destino).size / (1024 * 1024)
console.log(`Suporte remoto: ${destino} (${mb.toFixed(1)} MB)`)
if (mb > LIMITE_MB) {
  console.error(`O exe passou do limite de ${LIMITE_MB} MB.`)
  process.exit(1)
}
