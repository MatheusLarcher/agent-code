import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Finds an icon inside a project folder so the sidebar can show it next to the
 * project name. There is no manifest to read: a project is just a folder the
 * user opened, so the file is found by CONVENTION — a short guided walk over the
 * folders a repo keeps assets in, and a name that reads as "the project's icon".
 *
 * Two things the first version got wrong, both seen in a real project
 * (`frontend/public/icone_logo.png`): the asset folder can be nested under a
 * sub-app (`frontend/`, `client/`, `apps/web/`), and the name is written by a
 * person — `icone_logo`, `Logo_sem_fundo`, `logo-principal`. So the match is by
 * WORDS in the name, not by a closed list of exact stems.
 */

/** Sub-app folders worth descending into (they usually hold the asset folder). */
const APP_DIRS = new Set([
  'frontend',
  'front',
  'front-end',
  'client',
  'web',
  'webapp',
  'site',
  'ui',
  'app',
  'apps',
  'src',
  'packages',
  'desktop',
  'mobile',
  'android',
  'ios',
  'src-tauri',
  'electron',
  'renderer'
])

/** Folders that actually hold images. Descended into, and scanned for files. */
const ASSET_DIRS = new Set([
  'public',
  'assets',
  'asset',
  'static',
  'resources',
  'resource',
  'images',
  'image',
  'img',
  'icons',
  'icon',
  'logos',
  'logo',
  'media',
  'build',
  'www',
  'brand'
])

/** Never descend into these, however the walk got there. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'out',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'vendor',
  'tmp',
  'temp'
])

/** Words that make a file the project's mark. First match wins (lower = better). */
const BRAND_WORDS = ['icon', 'icone', 'favicon', 'logo', 'logotipo', 'marca', 'brand', 'symbol']

/**
 * Words that say the image is NOT an icon, even carrying a brand word:
 * `logo-banner.png` is a banner, `og-image.png` is a social card.
 */
const NOT_ICON_WORDS = new Set([
  'banner',
  'background',
  'bg',
  'cover',
  'capa',
  'hero',
  'screenshot',
  'screen',
  'print',
  'wallpaper',
  'mockup',
  'preview',
  'og',
  'thumbnail',
  'thumb',
  'placeholder',
  'header',
  'footer',
  'splash'
])

/** Extension → mime, in order of preference. `.ico` renders in <img> on Chromium. */
const EXTS: Array<[string, string]> = [
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg']
]

/** An icon bigger than this is not an icon — don't turn it into a data URL. */
const MAX_BYTES = 2 * 1024 * 1024
/** Depth 0 = the project root. `frontend/public/x.png` is depth 2. */
const MAX_DEPTH = 3
/** Ceiling on folders listed, so a huge monorepo can't turn this into a crawl. */
const MAX_DIRS = 48
/** How many candidates may be opened before giving up (empty/huge files skipped). */
const MAX_CANDIDATE_READS = 5

/** Lowercase, unaccented words of a file stem (`Logo_sem_fundo` → logo, sem, fundo). */
function words(stem: string): string[] {
  const spaced = stem.replace(/([a-z\d])([A-Z])/g, '$1 $2')
  // ̀-ͯ = the combining marks NFD splits accents into (ícone → icone).
  const flat = spaced
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return flat.split(/[^a-z\d]+/).filter(Boolean)
}

interface Rank {
  /** Index in BRAND_WORDS — lower wins. */
  brand: number
  /** Extra words beyond the brand one (`icone_logo` → 1) — fewer wins. */
  extras: number
  /** Folder depth from the project root — shallower wins. */
  depth: number
  /** Index in EXTS — lower wins. */
  ext: number
  /** Biggest declared size (`icon-512` → 512), the sharpest to scale down. */
  size: number
  mime: string
}

/** Rank of a file name as the project's icon, or null when it isn't one. */
function rank(fileName: string, depth: number): Rank | null {
  const lower = fileName.toLowerCase()
  const extIndex = EXTS.findIndex(([ext]) => lower.endsWith(ext))
  if (extIndex < 0) return null
  const parts = words(fileName.slice(0, fileName.length - EXTS[extIndex][0].length))
  if (parts.length === 0) return null

  let brand = -1
  let size = 0
  let extras = 0
  for (const part of parts) {
    if (NOT_ICON_WORDS.has(part)) return null
    const index = BRAND_WORDS.indexOf(part)
    if (index >= 0) {
      if (brand < 0 || index < brand) brand = index
      continue
    }
    // `32x32`, `512` — a resolution, not a different picture.
    const asSize = /^(\d+)(x\d+)?$/.exec(part)
    if (asSize) size = Math.max(size, Number.parseInt(asSize[1], 10))
    extras++
  }
  if (brand < 0) return null
  return { brand, extras, depth, ext: extIndex, size, mime: EXTS[extIndex][1] }
}

/** True when `a` is a better icon candidate than `b`. */
function better(a: Rank, b: Rank): boolean {
  if (a.brand !== b.brand) return a.brand < b.brand
  if (a.extras !== b.extras) return a.extras < b.extras
  if (a.depth !== b.depth) return a.depth < b.depth
  if (a.ext !== b.ext) return a.ext < b.ext
  return a.size > b.size
}

/** Should the walk go inside this folder? Only named asset/sub-app folders. */
function worthDescending(name: string, depth: number): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('.') || SKIP_DIRS.has(lower)) return false
  if (depth >= MAX_DEPTH) return false
  return ASSET_DIRS.has(lower) || APP_DIRS.has(lower)
}

/**
 * Returns the project's icon as a `data:` URL, or null when the folder has none
 * (the common case — the sidebar then keeps the folder glyph). Never throws: a
 * missing/unreadable folder is simply "no icon".
 */
export async function readProjectIcon(root: string): Promise<string | null> {
  if (!root) return null
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const found: Array<{ file: string; rank: Rank }> = []
  let listed = 0

  while (queue.length > 0 && listed < MAX_DIRS) {
    const { dir, depth } = queue.shift()!
    let entries: Awaited<ReturnType<typeof readdir>> | null = null
    try {
      entries = await readdir(dir, { withFileTypes: true })
      listed++
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (worthDescending(entry.name, depth + 1)) {
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      const r = rank(entry.name, depth)
      if (r) found.push({ file: join(dir, entry.name), rank: r })
    }
  }

  // Best first, and keep going down the list: a zero-byte or oversized file is
  // not an icon, but the project may still have a good one right behind it.
  found.sort((a, b) => (better(a.rank, b.rank) ? -1 : better(b.rank, a.rank) ? 1 : 0))
  for (const candidate of found.slice(0, MAX_CANDIDATE_READS)) {
    try {
      const info = await stat(candidate.file)
      if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) continue
      const bytes = await readFile(candidate.file)
      return `data:${candidate.rank.mime};base64,${bytes.toString('base64')}`
    } catch {
      continue
    }
  }
  return null
}
