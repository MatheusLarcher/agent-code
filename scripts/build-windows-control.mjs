import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('Controle do Windows: build ignorado fora do Windows.')
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const project = resolve(root, 'src/main/windowsControl/native/AgentCode.WindowsControl.csproj')
const output = resolve(root, 'out/windows-control')
const args = [
  'publish', project,
  '--configuration', 'Release',
  '--runtime', 'win-x64',
  '--self-contained', 'true',
  '--output', output,
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:DebugType=None',
  '-p:DebugSymbols=false'
]

const run = spawnSync('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true })
if (run.error) {
  console.error('Não foi possível iniciar o SDK .NET. Instale o .NET SDK 8+ para compilar o controle do Windows.')
  console.error(run.error.message)
  process.exit(1)
}
process.exit(run.status ?? 1)
