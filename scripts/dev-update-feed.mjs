// Feed local de atualização para o ENSAIO em instância isolada (sem instalar nada).
//
//   node scripts/dev-update-feed.mjs [--version 0.1.999] [--port 8787]
//
// Pega a build que está em dist/ (latest.yml, AgentCode-setup.exe, .blockmap),
// reescreve a versão do latest.yml numa cópia em %TEMP% — mantendo sha512 e
// tamanho, porque o arquivo servido é o mesmo — e serve tudo por HTTP em
// 127.0.0.1. Grava dev-app-update.yml na raiz do repositório (gitignored) com
// `provider: generic` apontando para cá e uma pasta de cache do updater
// própria, para não tocar na do app instalado.
//
// A instância isolada lê esse yml com:
//   AGENT_CODE_DEV_DATA_DIR=<pasta>  AGENT_CODE_DEV_UPDATE_FEED=1  AGENT_CODE_DEV_UPDATE_DRY_INSTALL=1
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] ?? null
}

const latestFile = join(dist, 'latest.yml')
if (!existsSync(latestFile)) {
  console.error('dist/latest.yml não existe: gere a build antes (npm run package:win ou scripts\\build-installer.bat).')
  process.exit(1)
}
const latest = readFileSync(latestFile, 'utf8')
const built = /^version:\s*(\S+)/m.exec(latest)?.[1]
if (!built) {
  console.error('dist/latest.yml sem a linha "version:".')
  process.exit(1)
}
const setupName = /^\s+-\s+url:\s*(\S+)/m.exec(latest)?.[1] ?? 'AgentCode-setup.exe'
const setupFile = join(dist, setupName)
const blockmapFile = `${setupFile}.blockmap`
for (const file of [setupFile, blockmapFile]) {
  if (!existsSync(file)) {
    console.error(`${file} não existe.`)
    process.exit(1)
  }
}

// Versão do feed: a pedida, ou a da build com o patch + 1 (o app em dev tem a versão do package.json).
const bump = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${v}.1`
}
const version = flag('--version') ?? bump(built)
const port = Number(flag('--port') ?? 8787)

const feedDir = join(tmpdir(), 'agent-code-feed')
mkdirSync(feedDir, { recursive: true })
const servedLatest = latest.replace(/^version:\s*\S+/m, `version: ${version}`)
writeFileSync(join(feedDir, 'latest.yml'), servedLatest, 'utf8')

const baseUrl = `http://127.0.0.1:${port}/`
const devConfig = join(root, 'dev-app-update.yml')
writeFileSync(
  devConfig,
  `# Gerado por scripts/dev-update-feed.mjs para o ensaio; gitignored.\n` +
    `provider: generic\nurl: ${baseUrl}\nupdaterCacheDirName: agent-code-desktop-updater-ensaio\n`,
  'utf8'
)

const files = new Map([
  ['/latest.yml', { path: join(feedDir, 'latest.yml'), type: 'text/yaml' }],
  [`/${setupName}`, { path: setupFile, type: 'application/octet-stream' }],
  [`/${basename(blockmapFile)}`, { path: blockmapFile, type: 'application/octet-stream' }]
])

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', baseUrl)
  const entry = files.get(url.pathname)
  const stamp = new Date().toISOString().slice(11, 19)
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    console.log(`[${stamp}] ${req.method} ${url.pathname} → 404`)
    res.writeHead(404).end()
    return
  }
  const size = statSync(entry.path).size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0
  let end = size - 1
  if (range) {
    if (range[1]) start = Number(range[1])
    if (range[2]) end = Number(range[2])
    if (!range[1] && range[2]) {
      start = Math.max(0, size - Number(range[2]))
      end = size - 1
    }
    end = Math.min(end, size - 1)
  }
  const partial = !!range
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': entry.type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  })
  console.log(`[${stamp}] ${req.method} ${url.pathname}${partial ? ` [${start}-${end}]` : ''} → ${partial ? 206 : 200} (${size} bytes)`)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(entry.path, { start, end }).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Feed de ensaio em ${baseUrl}`)
  console.log(`  build em dist/: ${built}  →  servida como: ${version}`)
  console.log(`  ${setupName} (${statSync(setupFile).size} bytes), ${basename(blockmapFile)}, latest.yml`)
  console.log(`  dev-app-update.yml gravado em ${devConfig}`)
  console.log('Instância isolada: AGENT_CODE_DEV_DATA_DIR=<pasta> AGENT_CODE_DEV_UPDATE_FEED=1 AGENT_CODE_DEV_UPDATE_DRY_INSTALL=1')
  console.log('Ctrl+C para parar.')
})
