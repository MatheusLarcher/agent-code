/**
 * Detector da cor do projeto — a parte de DISCO: uma caminhada curta e limitada
 * pelas pastas onde os projetos guardam tema e estilo (como o achador de ícone,
 * projectIcon.ts, e reaproveitando o logo que ele acha), lendo só arquivos
 * pequenos com nome de tema/estilo. Tudo assíncrono; qualquer erro vira "sem
 * cor" (o chamador cai na reserva). A decodificação do logo raster é injetada
 * (no app, `nativeImage` — projectColorImage.ts; nos testes, um falso).
 */
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ProjectColor } from '../shared/projectColor'
import {
  collectCandidates,
  decideProjectColor,
  dominantColor,
  dominantPixelColor,
  svgColorSamples,
  type ColorCandidate,
  type Pixels,
  type ScannedFile
} from './projectColor'
import { APP_DIRS, ASSET_DIRS, SKIP_DIRS, findProjectIconFile } from './projectIcon'

/** Decodifica um logo raster (PNG/JPEG/ICO) em pixels RGBA; null = formato não suportado. */
export type DecodeImage = (icon: { file: string; mime: string; bytes: Buffer }) => Promise<Pixels | null>

/** Pastas de tema/estilo, além das de app e de asset do achador de ícone. */
const THEME_DIRS = new Set([
  'styles',
  'style',
  'css',
  'scss',
  'sass',
  'theme',
  'themes',
  'lib',
  'core',
  'config',
  'main',
  'res',
  'values'
])

/** Pastas que nunca entram, além das do achador de ícone. */
const EXTRA_SKIP = new Set(['build', 'graphify-out', 'docs', 'test', 'tests', '__tests__', 'e2e', 'android-build'])

/** Profundidade 0 = raiz. `android/app/src/main/res/values` é 6. */
const MAX_DEPTH = 6
/** Teto de pastas listadas e de arquivos lidos: monorepo grande não vira varredura. */
const MAX_DIRS = 120
const MAX_FILES = 60
/** Arquivo de tema maior que isto é gerado/minificado — não é onde a cor é declarada. */
const MAX_TEXT_BYTES = 256 * 1024
/** HTML só perto da raiz (`index.html`, `public/index.html`, `frontend/index.html`). */
const MAX_HTML_DEPTH = 2

/** Prioridade de leitura do arquivo (menor primeiro), ou null se não interessa. */
function filePriority(name: string, depth: number): number | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.min.css') || lower.endsWith('.d.ts')) return null
  if (/^tailwind\.config\.(js|cjs|mjs|ts)$/.test(lower)) return 0
  if (/\.(css|scss|sass|less)$/.test(lower)) return 1
  if (lower === 'colors.xml') return 1
  if (/\.html?$/.test(lower)) return depth <= MAX_HTML_DEPTH ? 2 : null
  if (/\.dart$/.test(lower)) return /(theme|color|main|app)/.test(lower) ? 2 : null
  if (/\.(m?[jt]sx?)$/.test(lower)) return /theme/.test(lower) ? 3 : null
  if (lower === 'manifest.json' || lower.endsWith('.webmanifest')) return 4
  return null
}

function worthDescending(name: string, depth: number): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('.') || SKIP_DIRS.has(lower) || EXTRA_SKIP.has(lower)) return false
  if (depth > MAX_DEPTH) return false
  return APP_DIRS.has(lower) || ASSET_DIRS.has(lower) || THEME_DIRS.has(lower)
}

const relPath = (root: string, file: string): string => relative(root, file).split(sep).join('/')

/** Os arquivos de tema/estilo do projeto (texto), rasos primeiro. */
export async function scanThemeFiles(root: string): Promise<ScannedFile[]> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const found: Array<{ file: string; depth: number; priority: number }> = []
  let listed = 0
  while (queue.length > 0 && listed < MAX_DIRS) {
    const { dir, depth } = queue.shift()!
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
      listed++
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (worthDescending(entry.name, depth + 1)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const priority = filePriority(entry.name, depth)
      if (priority !== null) found.push({ file: join(dir, entry.name), depth, priority })
    }
  }
  found.sort((a, b) => a.depth - b.depth || a.priority - b.priority || a.file.localeCompare(b.file))
  const out: ScannedFile[] = []
  for (const f of found.slice(0, MAX_FILES)) {
    try {
      const info = await stat(f.file)
      if (!info.isFile() || info.size === 0 || info.size > MAX_TEXT_BYTES) continue
      out.push({ rel: relPath(root, f.file), text: await readFile(f.file, 'utf8') })
    } catch {
      continue
    }
  }
  return out
}

/** A cor dominante do logo do projeto (o mesmo da barra lateral), ou null. */
export async function scanLogoColor(root: string, decode: DecodeImage): Promise<ColorCandidate | null> {
  const icon = await findProjectIconFile(root)
  if (!icon) return null
  const file = relPath(root, icon.file)
  try {
    if (icon.mime === 'image/svg+xml') {
      const rgb = dominantColor(svgColorSamples(icon.bytes.toString('utf8')))
      return rgb ? { color: { ...rgb, a: 1 }, file } : null
    }
    if (icon.mime === 'image/webp') return null
    const pixels = await decode(icon)
    const rgb = pixels ? dominantPixelColor(pixels) : null
    return rgb ? { color: { ...rgb, a: 1 }, file } : null
  } catch {
    return null
  }
}

/**
 * A cor do projeto em `root` pelas fontes, ou null quando nenhuma dá cor
 * aceitável (pasta vazia, inexistente, sem tema). Nunca lança.
 */
export async function detectProjectColor(root: string, decode: DecodeImage): Promise<ProjectColor | null> {
  if (!root) return null
  try {
    const [files, logo] = await Promise.all([scanThemeFiles(root), scanLogoColor(root, decode)])
    return decideProjectColor({ ...collectCandidates(files), logo })
  } catch {
    return null
  }
}
