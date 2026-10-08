// PostgreSQL embutido: baixa os binários oficiais da EDB para Windows x64, confere
// o SHA-256 fixado abaixo e recorta o que o app usa em `out/postgres/`, de onde o
// electron-builder o leva para resources/postgres (extraResources).
//
//   node scripts/stage-postgres.mjs                    prepara out/postgres
//   node scripts/stage-postgres.mjs --verify <pasta>   confere uma cópia empacotada
//                                                      (ex.: dist\win-unpacked\resources\postgres)
//
// Versão nova = trocar VERSION e SHA256 (o hash é calculado do download oficial).
// O zip fica em cache em node_modules/.cache: só baixa de novo se faltar ou não bater.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkImports } from './pe-imports.mjs'

const VERSION = '18.6-5'
const ZIP_URL = `https://get.enterprisedb.com/postgresql/postgresql-${VERSION}-windows-x64-binaries.zip`
const SHA256 = 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2'
const MARKER = 'agent-code-postgres.json'

const root = resolve(import.meta.dirname, '..')
const dest = join(root, 'out', 'postgres')
const zipPath = join(root, 'node_modules', '.cache', 'agent-code-postgres', `postgresql-${VERSION}-windows-x64-binaries.zip`)
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

// Vai no app: servidor e ferramentas (bin), módulos carregados pelo servidor (lib),
// o que o initdb e o servidor leem (share) e as licenças. Fica fora: pgAdmin,
// StackBuilder (GUI — o Postgres do app nunca abre janela), docs, include,
// bibliotecas de link (.lib/.a, pgxs, pkgconfig) e as linguagens procedurais que
// dependem de Perl, Python ou Tcl instalados na máquina.
const MEMBERS = ['pgsql/bin', 'pgsql/lib', 'pgsql/share', 'pgsql/server_license.txt', 'pgsql/commandlinetools_3rd_party_licenses.txt']
const EXCLUDES = [
  'pgsql/bin/stackbuilder.exe', 'pgsql/bin/wx*', 'pgsql/bin/*.lib',
  'pgsql/lib/*.lib', 'pgsql/lib/*.a', 'pgsql/lib/pgxs', 'pgsql/lib/pkgconfig',
  'pgsql/lib/*plperl*', 'pgsql/lib/*plpython*', 'pgsql/lib/*pltcl*'
]
/** O que o app executa: sem eles o stage não serve. O psql aplica a cópia num
 *  servidor da nuvem anterior ao 17 (persistence/backup/pgTools.ts). */
const REQUIRED = ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'pg_isready.exe', 'pg_dump.exe', 'pg_restore.exe', 'psql.exe']

const fail = (message) => {
  console.error(`[postgres] ${message}`)
  process.exit(1)
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function download() {
  if (existsSync(zipPath) && (await sha256(zipPath)) === SHA256) return
  mkdirSync(resolve(zipPath, '..'), { recursive: true })
  const partial = `${zipPath}.partial`
  console.log(`[postgres] baixando ${ZIP_URL}`)
  const response = await fetch(ZIP_URL)
  if (!response.ok || !response.body) fail(`download falhou: HTTP ${response.status}`)
  const hash = createHash('sha256')
  const tap = new Transform({ transform: (chunk, _enc, done) => { hash.update(chunk); done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(partial))
  const got = hash.digest('hex')
  if (got !== SHA256) {
    rmSync(partial, { force: true })
    fail(`SHA-256 do zip não confere (esperado ${SHA256}, veio ${got}). Nada foi extraído.`)
  }
  renameSync(partial, zipPath)
}

/** Confere uma pasta já recortada: binários presentes e nenhuma DLL de fora do Windows. */
function verify(dir, { copyVcRuntime }) {
  const bin = join(dir, 'bin')
  for (const name of REQUIRED) if (!existsSync(join(bin, name))) fail(`${name} ausente em ${bin}`)
  const roots = (folder) => readdirSync(folder).filter((n) => /\.(exe|dll)$/i.test(n)).map((n) => join(folder, n))
  const check = () => checkImports({ binDir: bin, roots: [...roots(bin), ...roots(join(dir, 'lib'))], system32 })
  let result = check()
  if (copyVcRuntime && result.vcRuntime.length) {
    // Cópia local ao app, sem o instalador central do VC++ (que pediria UAC).
    for (const dll of result.vcRuntime) {
      const from = join(system32, dll)
      if (!existsSync(from)) fail(`${dll} (runtime do Visual C++) não está em ${system32}; instale o VC++ 2015-2022 x64 na máquina de build`)
      copyFileSync(from, join(bin, dll))
      console.log(`[postgres] runtime do VC++ embutido: ${dll}`)
    }
    result = check()
  }
  if (result.vcRuntime.length) fail(`runtime do Visual C++ fora do pacote: ${result.vcRuntime.join(', ')}`)
  if (result.missing.length) {
    fail(`DLL fora do Windows e fora do pacote:\n${result.missing.map((m) => `  ${m.dll} (importada por ${m.from})`).join('\n')}`)
  }
  return result.checked
}

function sizeOf(path) {
  const info = statSync(path)
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0)
}

function stamp(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))
    return marker.version === VERSION && marker.sha256 === SHA256
  } catch {
    return false
  }
}

if (process.argv[2] === '--verify') {
  const dir = resolve(process.argv[3] ?? '')
  if (!stamp(dir)) fail(`${dir} não é o PostgreSQL ${VERSION} preparado por este script (${MARKER} ausente ou diferente)`)
  const checked = verify(dir, { copyVcRuntime: false })
  console.log(`[postgres] ${dir}: PostgreSQL ${VERSION}, ${checked} binários sem dependência fora do Windows`)
  process.exit(0)
}

if (process.platform !== 'win32') {
  console.log('[postgres] staging ignorado fora do Windows.')
  process.exit(0)
}

if (stamp(dest)) {
  verify(dest, { copyVcRuntime: false })
  console.log(`[postgres] out/postgres já é o PostgreSQL ${VERSION}.`)
  process.exit(0)
}

await download()
const staging = `${dest}.tmp-${process.pid}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
// O tar do Windows (bsdtar) lê zip; o do Git (GNU tar) não — por isso o caminho completo.
const tar = spawnSync(
  join(system32, 'tar.exe'),
  ['-xf', zipPath, '-C', staging, '--strip-components', '1', ...EXCLUDES.flatMap((p) => ['--exclude', p]), ...MEMBERS],
  { stdio: 'inherit', windowsHide: true }
)
if (tar.error || tar.status !== 0) fail(`extração falhou (${tar.error?.message ?? `tar saiu com ${tar.status}`})`)
const checked = verify(staging, { copyVcRuntime: true })
writeFileSync(join(staging, MARKER), JSON.stringify({ version: VERSION, sha256: SHA256, url: ZIP_URL }, null, 2))
rmSync(dest, { recursive: true, force: true })
renameSync(staging, dest)
console.log(`[postgres] out/postgres: PostgreSQL ${VERSION}, ${(sizeOf(dest) / 1048576).toFixed(1)} MB, ${checked} binários conferidos`)
