import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Fallback of projectIcon.ts for Android projects: their icon is not a file
 * named `icon`/`logo` in an asset folder, it is the resource the manifest points
 * to (`android:icon="@mipmap/ic_launcher"`), several folders deep, and often
 * only a vector XML (adaptive icon) that <img> cannot show. So: read the
 * manifest, prefer the sharpest raster density, else turn the vector drawable(s)
 * into an SVG.
 */

export interface IconFile {
  file: string
  mime: string
  bytes: Buffer
}

/** Where a Gradle app module usually keeps its main source set. */
const MANIFEST_DIRS = ['app/src/main', 'src/main', 'android/app/src/main']

/** Raster densities, sharpest first. */
const DENSITIES = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'nodpi', '']
const RASTER: Array<[string, string]> = [
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg']
]
const MAX_BYTES = 2 * 1024 * 1024

const ANDROID_COLORS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'none'
}

async function readText(file: string): Promise<string | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) return null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && info.size > 0 && info.size <= MAX_BYTES
  } catch {
    return false
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Value of `android:<name>="..."` inside one tag's text. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`android:${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

/** `@mipmap/ic_launcher` → { type: 'mipmap', name: 'ic_launcher' }. */
function parseRef(ref: string): { type: string; name: string } | null {
  const m = /^@(?:\+)?(mipmap|drawable|color)\/([\w.]+)$/.exec(ref.trim())
  return m ? { type: m[1], name: m[2] } : null
}

class AndroidRes {
  private colors: Record<string, string> | null = null
  constructor(private readonly res: string) {}

  /** `#RGB`/`#ARGB`/`#RRGGBB`/`#AARRGGBB` or `@color/x` → an SVG color. */
  async color(value: string | null): Promise<string | null> {
    if (!value) return null
    const v = value.trim()
    const sys = /^@android:color\/(\w+)$/.exec(v)
    if (sys) return ANDROID_COLORS[sys[1]] ?? null
    const ref = parseRef(v)
    if (ref?.type === 'color') return this.color((await this.colorTable())[ref.name] ?? null)
    return hexToSvg(v)
  }

  private async colorTable(): Promise<Record<string, string>> {
    if (this.colors) return this.colors
    const table: Record<string, string> = {}
    for (const dir of ['values']) {
      let files: string[] = []
      try {
        files = (await readdir(join(this.res, dir))).filter((f) => f.endsWith('.xml'))
      } catch {
        continue
      }
      for (const f of files) {
        const text = await readText(join(this.res, dir, f))
        if (!text) continue
        for (const m of text.matchAll(/<color\s+name="([\w.]+)"\s*>\s*([^<]+?)\s*<\/color>/g)) table[m[1]] = m[2]
      }
    }
    this.colors = table
    return table
  }

  /** Folders of a resource type, default density last (`mipmap-xxxhdpi` … `mipmap`). */
  private async folders(type: string): Promise<string[]> {
    const dirs = (await listDirs(this.res)).filter((d) => d === type || d.startsWith(`${type}-`))
    const score = (d: string): number => {
      const i = DENSITIES.findIndex((q) => q && d.includes(q))
      return i < 0 ? DENSITIES.length : i
    }
    return dirs.sort((a, b) => score(a) - score(b))
  }

  /** The best file for a resource: sharpest raster first, else its XML. */
  async find(type: string, name: string): Promise<{ file: string; mime: string } | null> {
    const types = type === 'mipmap' || type === 'drawable' ? [type, type === 'mipmap' ? 'drawable' : 'mipmap'] : [type]
    let xml: string | null = null
    for (const t of types) {
      for (const dir of await this.folders(t)) {
        for (const [ext, mime] of RASTER) {
          const file = join(this.res, dir, name + ext)
          if (await isFile(file)) return { file, mime }
        }
        const file = join(this.res, dir, `${name}.xml`)
        if (!xml && (await isFile(file))) xml = file
      }
    }
    return xml ? { file: xml, mime: 'application/xml' } : null
  }
}

function hexToSvg(v: string): string | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(v)
  if (!m) return null
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  if (h.length === 6) return `#${h}`
  if (h.length !== 8) return null
  const a = parseInt(h.slice(0, 2), 16) / 255
  const [r, g, b] = [2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16))
  return a >= 1 ? `#${h.slice(2)}` : `rgba(${r},${g},${b},${a.toFixed(3)})`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** `<vector>` XML → SVG markup (`<svg>` sized to `size` user units). */
async function vectorToSvg(xml: string, res: AndroidRes, size: number): Promise<string | null> {
  const root = /<vector\b[^>]*>/.exec(xml)
  if (!root) return null
  const vw = Number(attr(root[0], 'viewportWidth')) || 24
  const vh = Number(attr(root[0], 'viewportHeight')) || 24
  let body = ''
  for (const m of xml.matchAll(/<(\/?)(group|path|clip-path)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m
    if (tag === 'group') {
      if (closing) {
        body += '</g>'
        continue
      }
      const px = Number(attr(attrs, 'pivotX')) || 0
      const py = Number(attr(attrs, 'pivotY')) || 0
      const tx = Number(attr(attrs, 'translateX')) || 0
      const ty = Number(attr(attrs, 'translateY')) || 0
      const sx = Number(attr(attrs, 'scaleX') ?? 1)
      const sy = Number(attr(attrs, 'scaleY') ?? 1)
      const rot = Number(attr(attrs, 'rotation')) || 0
      // Android order: translate, then rotate/scale around the pivot.
      const t = `translate(${tx + px} ${ty + py}) rotate(${rot}) scale(${sx} ${sy}) translate(${-px} ${-py})`
      body += selfClosing ? '' : `<g transform="${t}">`
      continue
    }
    if (tag !== 'path' || closing) continue
    const d = attr(attrs, 'pathData')
    if (!d) continue
    const fill = (await res.color(attr(attrs, 'fillColor'))) ?? 'none'
    const stroke = await res.color(attr(attrs, 'strokeColor'))
    let out = `<path d="${esc(d)}" fill="${fill}"`
    const fillAlpha = attr(attrs, 'fillAlpha')
    if (fillAlpha) out += ` fill-opacity="${fillAlpha}"`
    if (attr(attrs, 'fillType') === 'evenOdd') out += ' fill-rule="evenodd"'
    if (stroke) {
      out += ` stroke="${stroke}" stroke-width="${attr(attrs, 'strokeWidth') ?? 0}"`
      const join = attr(attrs, 'strokeLineJoin')
      const cap = attr(attrs, 'strokeLineCap')
      if (join) out += ` stroke-linejoin="${join}"`
      if (cap) out += ` stroke-linecap="${cap}"`
    }
    body += `${out}/>`
  }
  return `<svg x="0" y="0" width="${size}" height="${size}" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="none">${body}</svg>`
}

/** One layer of an adaptive icon (or a plain drawable) as SVG markup, 108×108. */
async function layer(ref: string | null, res: AndroidRes): Promise<string> {
  if (!ref) return ''
  const color = await res.color(ref)
  if (color) return `<rect width="108" height="108" fill="${color}"/>`
  const parsed = parseRef(ref)
  if (!parsed) return ''
  const found = await res.find(parsed.type, parsed.name)
  if (!found) return ''
  if (found.mime !== 'application/xml') {
    const bytes = await readFile(found.file)
    return `<image width="108" height="108" href="data:${found.mime};base64,${bytes.toString('base64')}"/>`
  }
  const xml = (await readText(found.file)) ?? ''
  return (await vectorToSvg(xml, res, 108)) ?? ''
}

/** The Android launcher icon of the project, or null. Never throws. */
export async function findAndroidIcon(root: string): Promise<IconFile | null> {
  try {
    for (const rel of MANIFEST_DIRS) {
      const main = join(root, rel)
      const manifest = await readText(join(main, 'AndroidManifest.xml'))
      if (!manifest) continue
      const app = /<application\b[^>]*>/.exec(manifest)
      const ref = parseRef((app && attr(app[0], 'icon')) ?? '@mipmap/ic_launcher')
      if (!ref) continue
      const res = new AndroidRes(join(main, 'res'))
      const found = await res.find(ref.type, ref.name)
      if (!found) continue
      if (found.mime !== 'application/xml') {
        return { file: found.file, mime: found.mime, bytes: await readFile(found.file) }
      }
      const xml = (await readText(found.file)) ?? ''
      let svg: string | null = null
      const adaptive = /<adaptive-icon\b[\s\S]*<\/adaptive-icon>/.exec(xml)
      if (adaptive) {
        const pick = (tag: string): string | null => {
          const m = new RegExp(`<${tag}\\b[^>]*>`).exec(adaptive[0])
          return m ? attr(m[0], 'drawable') : null
        }
        const back = await layer(pick('background'), res)
        const front = await layer(pick('foreground'), res)
        if (back || front) {
          // Launchers show the inner 72dp of the 108dp canvas, masked.
          svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="72" height="72">' +
            '<defs><clipPath id="m"><rect x="18" y="18" width="72" height="72" rx="16"/></clipPath></defs>' +
            `<g clip-path="url(#m)">${back}${front}</g></svg>`
        }
      } else if (/<vector\b/.test(xml)) {
        const inner = await vectorToSvg(xml, res, 108)
        if (inner) svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">${inner}</svg>`
      }
      if (svg) return { file: found.file, mime: 'image/svg+xml', bytes: Buffer.from(svg, 'utf8') }
    }
  } catch {
    return null
  }
  return null
}
