// Ensaio da troca rápida (src/main/appUpdate/fastSwap.ts) numa pasta descartável,
// sem tocar no app instalado: monta uma "instalação" com um processo vivo dentro
// dela, uma pasta "nova" (opcionalmente uma árvore grande já extraída, para medir)
// e dispara o script real de troca. O resultado sai em <sandbox>\atualizacao.log.
//
//   node --experimental-transform-types scripts/ensaio-troca-rapida.mjs <sandbox> [arvore-extraida]
//
// A árvore extraída é MOVIDA para dentro da sandbox. O "app" novo é uma cópia do
// whoami.exe (abre e fecha); o registro real não é alterado (o caminho da sandbox
// não bate com nenhuma entrada de desinstalação).
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { launchSwap, stagedDirFor } = await import(
  pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'main', 'appUpdate', 'fastSwap.ts')).href
)
const root = process.argv[2]
const bigTree = process.argv[3]
if (!root) {
  console.error('uso: node --experimental-transform-types scripts/ensaio-troca-rapida.mjs <sandbox> [arvore-extraida]')
  process.exit(1)
}
rmSync(root, { recursive: true, force: true })
const installDir = join(root, 'Programs', 'agent-code-desktop')
mkdirSync(installDir, { recursive: true })
writeFileSync(join(installDir, 'versao.txt'), 'velha')
writeFileSync(join(installDir, 'Uninstall Agent Code.exe'), 'desinstalador')
cpSync('C:/Windows/System32/PING.EXE', join(installDir, 'helper.exe'))
const staged = stagedDirFor(installDir, '9.9.9')
if (bigTree) renameSync(bigTree, staged)
else mkdirSync(staged, { recursive: true })
writeFileSync(join(staged, 'versao.txt'), 'nova')
cpSync('C:/Windows/System32/whoami.exe', join(staged, 'Agent Code.exe'))
// O "app" vivo dentro da pasta: um ping de ~4 s rodando do executável da instalação.
const app = spawn(join(installDir, 'helper.exe'), ['-n', '5', '127.0.0.1'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true })
app.unref()
console.log(`app falso pid ${app.pid}; troca disparada ${new Date().toISOString()}; log em ${join(root, 'atualizacao.log')}`)
launchSwap(
  {
    appPid: app.pid,
    installDir,
    stagedDir: staged,
    exeName: 'Agent Code.exe',
    version: '9.9.9',
    setupFile: join(root, 'setup-inexistente.exe'),
    logFile: join(root, 'atualizacao.log')
  },
  root
)
