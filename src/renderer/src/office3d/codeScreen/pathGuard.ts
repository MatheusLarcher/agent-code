/**
 * Guarda dos caminhos do monitor de código (Escritório 3D) — PURO.
 *
 * O editor do monitor lê do disco (window.api.readFile) só o arquivo que o
 * agent mexeu e só quando é seguro: caminho ABSOLUTO, DENTRO da pasta da
 * conversa (cwd) e sem nome sensível (.env, chaves, credenciais…). Fora disso a
 * tela mostra só os trechos que estão na própria entrada da ferramenta.
 *
 *   normalizePath(p)         forma comparável: barras normais, sem `.`/`..`, sem
 *                            barra final; minúsculo em caminho Windows
 *   isInside(p, cwd)         p fica abaixo de cwd (a própria pasta não conta)
 *   isSensitivePath(p)       nome ou pasta que guarda segredo
 *   diskReadVerdict(p, cwd)  'ok' | 'relative' | 'outside' | 'sensitive'
 *   relativePath(p, cwd)     p relativo ao cwd, com a caixa original (null fora dele)
 */

export type ReadVerdict = 'ok' | 'relative' | 'outside' | 'sensitive'

interface Parsed {
  /** 'C:/', '//servidor/pasta/', '/' ou '' (relativo). */
  root: string
  parts: string[]
  /** Caminho Windows: a comparação ignora a caixa. */
  windows: boolean
}

function parse(p: string): Parsed {
  const windows = /^[a-zA-Z]:/.test(p) || p.includes('\\')
  const s = p.replace(/\\/g, '/')
  let root = ''
  let rest = s
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(s)
  const unc = /^\/\/([^/]+)\/([^/]+)/.exec(s)
  if (drive) {
    root = `${drive[1].toUpperCase()}/`
    rest = s.slice(drive[0].length)
  } else if (unc) {
    root = `//${unc[1]}/${unc[2]}/`
    rest = s.slice(unc[0].length)
  } else if (s.startsWith('/')) {
    root = '/'
    rest = s.slice(1)
  }
  const parts: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg !== '..') parts.push(seg)
    else if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
    else if (!root) parts.push('..')
  }
  return { root, parts, windows }
}

export function normalizePath(p: string): string {
  const { root, parts, windows } = parse(p)
  const s = root + parts.join('/')
  return windows ? s.toLowerCase() : s
}

export function isInside(p: string, cwd: string): boolean {
  const a = parse(p)
  const b = parse(cwd)
  if (!a.root || !b.root || a.parts.length <= b.parts.length) return false
  const win = a.windows || b.windows
  const same = (x: string, y: string): boolean => (win ? x.toLowerCase() === y.toLowerCase() : x === y)
  return same(a.root, b.root) && b.parts.every((seg, i) => same(seg, a.parts[i]))
}

/** Pastas de segredo (em qualquer nível do caminho). */
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'])
/** Nomes de arquivo de segredo (comparados em minúsculas). */
const SENSITIVE_NAMES: RegExp[] = [
  // `.env*`: qualquer nome que comece com .env (.env, .env.local, .env-backup, .envrc…).
  /^\.env/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /credential|secret|password|passwd/,
  /^\.(npmrc|pypirc|netrc|pgpass|htpasswd|git-credentials|dockercfg)$/,
  /^_netrc$/
]

export function isSensitivePath(p: string): boolean {
  const parts = parse(p).parts.map((s) => s.toLowerCase())
  const name = parts[parts.length - 1] ?? ''
  return parts.slice(0, -1).some((d) => SENSITIVE_DIRS.has(d)) || SENSITIVE_NAMES.some((re) => re.test(name))
}

export function diskReadVerdict(p: string, cwd: string): ReadVerdict {
  if (!parse(p).root) return 'relative'
  if (!cwd || !isInside(p, cwd)) return 'outside'
  return isSensitivePath(p) ? 'sensitive' : 'ok'
}

export function relativePath(p: string, cwd: string): string | null {
  const a = parse(p)
  if (!a.root) return a.parts.join('/')
  if (!cwd || !isInside(p, cwd)) return null
  return a.parts.slice(parse(cwd).parts.length).join('/')
}

/** O caminho com barras normais, como veio (para mostrar). */
export function slashed(p: string): string {
  return p.replace(/\\/g, '/')
}
