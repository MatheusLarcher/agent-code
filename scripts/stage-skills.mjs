// Copia as skills do cache desta máquina (as que o usuário instalou) para
// `.seed-skills/`, de onde o electron-builder as embute em
// resources/app/.agents/seed-skills. Na primeira execução de uma instalação
// nova, o skillManager semeia o cache com elas (sem nunca sobrescrever).
//
//   node scripts/stage-skills.mjs                           → prepara .seed-skills/
//   node scripts/stage-skills.mjs --verify <resources/app>  → confere o empacotado
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const STAGED = join(REPO, '.seed-skills')
const VALID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u
// Chaves reais não podem viajar dentro de um instalador distribuído.
const SECRET_PATTERNS = [
  /apikey_[0-9a-f]{20,}/i,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/
]
const TEXT_FILE = /\.(md|txt|json|ya?ml|js|mjs|cjs|ts|py|sh|ps1|bat|toml|ini|env)$/i

function skillNames(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VALID.test(e.name) && !e.name.endsWith('.agent-code-new'))
      .map((e) => e.name)
      .filter((name) => existsSync(join(root, name, 'SKILL.md')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

if (process.argv[2] === '--verify') {
  const appDir = resolve(process.argv[3] ?? '')
  const packed = skillNames(join(appDir, '.agents', 'seed-skills'))
  const missing = skillNames(STAGED).filter((name) => !packed.includes(name))
  if (packed.length === 0 || missing.length > 0) {
    console.error(`Skills: instalador sem as skills do cache (faltando: ${missing.join(', ') || 'todas'}).`)
    process.exit(1)
  }
  console.log(`Skills: ${packed.length} skills do cache embutidas no instalador.`)
  process.exit(0)
}

function cacheSkillsDir() {
  const pointer = join(homedir(), '.agent-code', 'location.json')
  try {
    const { cacheDir } = JSON.parse(readFileSync(pointer, 'utf8'))
    if (typeof cacheDir === 'string' && cacheDir) return join(cacheDir, 'skills')
  } catch {
    // sem ponteiro: o app nunca rodou nesta máquina
  }
  return ''
}

function findSecret(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findSecret(path)
      if (hit) return hit
    } else if (entry.isFile() && TEXT_FILE.test(entry.name) && statSync(path).size < 2_000_000) {
      const text = readFileSync(path, 'utf8')
      if (SECRET_PATTERNS.some((re) => re.test(text))) return path
    }
  }
  return ''
}

const source = cacheSkillsDir()
if (!source || !existsSync(source)) {
  console.error('Skills: pasta de cache não encontrada (~/.agent-code/location.json). Abra o Agent Code uma vez nesta máquina.')
  process.exit(1)
}

// As do repositório já vão por .agents/skills; aqui entra só o que o usuário instalou.
const bundled = new Set(skillNames(join(REPO, '.agents', 'skills')))
const names = skillNames(source).filter((name) => !bundled.has(name))
rmSync(STAGED, { recursive: true, force: true })
mkdirSync(STAGED, { recursive: true })

const leaked = names.map((name) => findSecret(join(source, name))).filter(Boolean)
if (leaked.length > 0) {
  console.error(`Skills: possível chave/senha em:\n  ${leaked.join('\n  ')}\nRemova antes de gerar o instalador.`)
  process.exit(1)
}

for (const name of names) {
  cpSync(join(source, name), join(STAGED, name), {
    recursive: true,
    filter: (path) => !/[\\/](\.git|node_modules|__pycache__)([\\/]|$)/.test(path.slice(source.length))
  })
}
console.log(`Skills: ${names.length} skills do cache (${source}) preparadas para o instalador.`)
