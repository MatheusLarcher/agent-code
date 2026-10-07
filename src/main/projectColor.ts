/**
 * Detector da cor do projeto — a parte PURA (sem fs, sem Electron): extrai as
 * cores candidatas dos textos dos arquivos, acha a cor dominante de um logo
 * (pixels ou SVG) e decide. A varredura do disco fica em projectColorScan.ts; a
 * fixação no KV em projectColorStore.ts.
 *
 * Ordem das fontes (a primeira aceitável vence): marca (`--brand`) → logo →
 * tema (`--primary`, Tailwind, MUI, colors.xml, Flutter, `--accent`) →
 * `theme-color`/`theme_color` (quase sempre o FUNDO, que o critério descarta).
 * Logo e tema concordando no matiz, vale o valor EXATO do tema (o logo dá uma
 * média de pixels; o tema, o hex que o projeto escreveu).
 */
import {
  chroma,
  hueDistance,
  isAcceptableColor,
  rgbToHsl,
  toHex,
  wearableColor,
  type ProjectColor,
  type ProjectColorSource,
  type Rgb,
  type Rgba
} from '../shared/projectColor'
import { parseAndroidColor, parseCssColor, parseFlutterColor, type CssVars } from './projectColorParse'

/** Uma cor achada num arquivo do projeto. `file` relativo à raiz, com `/`. */
export interface ColorCandidate {
  color: Rgba
  file: string
}

export interface ColorCandidates {
  marca: ColorCandidate[]
  tema: ColorCandidate[]
  themeColor: ColorCandidate[]
}

/** O que o decisor recebe: as candidatas de texto + a cor dominante do logo. */
export interface DetectionInput extends ColorCandidates {
  logo: ColorCandidate | null
}

/** Pixels RGBA (alfa NÃO pré-multiplicado), linha a linha. */
export interface Pixels {
  width: number
  height: number
  data: Uint8Array
}

/** Arquivo lido pela varredura: caminho relativo (`/`) e texto. */
export interface ScannedFile {
  rel: string
  text: string
}

const MARCA_VARS = ['brand', 'color-brand', 'brand-color', 'brand-primary']
/** Ordem = preferência: primária antes de destaque. */
const TEMA_VARS: Array<[string, number]> = [
  ['primary', 0],
  ['color-primary', 0],
  ['primary-color', 0],
  ['accent', 1],
  ['color-accent', 1],
  ['accent-color', 1]
]

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
const isStyleFile = (rel: string): boolean => /\.(css|scss|sass|less|html?)$/i.test(rel)

/** Todas as declarações `--nome: valor` de um texto CSS/HTML, na ordem. */
function customProps(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;{}<>\n]+)/g)) out.push([m[1].toLowerCase(), m[2].trim()])
  return out
}

/** O mapa de variáveis CSS do projeto inteiro (a primeira definição vence — o tema claro de `:root`). */
export function cssVarMap(files: readonly ScannedFile[]): Map<string, string> {
  const vars = new Map<string, string>()
  for (const f of files) {
    if (!isStyleFile(f.rel)) continue
    for (const [name, value] of customProps(f.text)) if (!vars.has(name)) vars.set(name, value)
  }
  return vars
}

/** `primary: '#…'` ou `primary: { DEFAULT: '#…', 500: '#…' }` de um tailwind.config. */
function tailwindColor(text: string, key: string, vars: CssVars): Rgba | null {
  const re = new RegExp(String.raw`['"]?\b${key}['"]?\s*:\s*(?:(['"\`])([^'"\`]+)\1|\{([^{}]*)\})`, 'g')
  for (const m of text.matchAll(re)) {
    if (m[2]) {
      const c = parseCssColor(m[2], vars)
      if (c) return c
      continue
    }
    const body = m[3] ?? ''
    for (const shade of ['DEFAULT', '500', '600', '400', '700']) {
      const s = new RegExp(String.raw`['"]?${shade}['"]?\s*:\s*(['"\`])([^'"\`]+)\1`).exec(body)
      const c = s ? parseCssColor(s[2], vars) : null
      if (c) return c
    }
    const first = /(['"`])([^'"`]+)\1/.exec(body)
    const c = first ? parseCssColor(first[2], vars) : null
    if (c) return c
  }
  return null
}

/**
 * As cores candidatas de texto, em ordem de preferência dentro de cada fonte.
 * `files` já vem ordenado pela varredura (raso primeiro).
 */
export function collectCandidates(files: readonly ScannedFile[]): ColorCandidates {
  const vars = cssVarMap(files)
  const marca: ColorCandidate[] = []
  const tema: Array<ColorCandidate & { rank: number }> = []
  const themeColor: ColorCandidate[] = []
  const push = (list: ColorCandidate[], color: Rgba | null, file: string): void => {
    if (color) list.push({ color, file })
  }

  for (const { rel, text } of files) {
    const name = baseName(rel)
    if (isStyleFile(rel)) {
      for (const [prop, value] of customProps(text)) {
        if (MARCA_VARS.includes(prop)) push(marca, parseCssColor(value, vars), rel)
        const t = TEMA_VARS.find(([n]) => n === prop)
        const c = t ? parseCssColor(value, vars) : null
        if (t && c) tema.push({ color: c, file: rel, rank: t[1] })
      }
      if (/\.html?$/i.test(rel)) {
        for (const tag of text.matchAll(/<meta\b[^>]*>/gi)) {
          if (!/name\s*=\s*["']theme-color["']/i.test(tag[0])) continue
          const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag[0])
          if (content) push(themeColor, parseCssColor(content[1], vars), rel)
        }
      }
    } else if (/^tailwind\.config\./.test(name)) {
      push(marca, tailwindColor(text, 'brand', vars), rel)
      const c = tailwindColor(text, 'primary', vars)
      if (c) tema.push({ color: c, file: rel, rank: 0 })
    } else if (name === 'colors.xml') {
      const re = /<color\s+name\s*=\s*"(colorPrimary|primary|md_theme_primary|md_theme_light_primary)"\s*>\s*([^<\s]+)\s*</g
      for (const m of text.matchAll(re)) {
        const c = parseAndroidColor(m[2])
        if (c) tema.push({ color: c, file: rel, rank: 0 })
      }
    } else if (name.endsWith('.dart')) {
      const re = /\b(?:seedColor|primaryColor)\s*:\s*((?:const\s+)?(?:Color\(\s*0x[0-9a-fA-F]{8}\s*\)|Colors\.\w+(?:\.shade\d+|\[\d+\])?))/g
      for (const m of text.matchAll(re)) {
        const c = parseFlutterColor(m[1])
        if (c) tema.push({ color: c, file: rel, rank: 0 })
      }
    } else if (/\.(json|webmanifest)$/.test(name)) {
      const m = /"theme_color"\s*:\s*"([^"]+)"/.exec(text)
      if (m) push(themeColor, parseCssColor(m[1], vars), rel)
    } else if (/\.(m?[jt]sx?)$/.test(name) && text.includes('createTheme')) {
      const m = /\bprimary\s*:\s*\{[^}]*?\bmain\s*:\s*(['"`])([^'"`]+)\1/.exec(text)
      if (m) {
        const c = parseCssColor(m[2], vars)
        if (c) tema.push({ color: c, file: rel, rank: 0 })
      }
    }
  }
  // Estável: dentro do mesmo grau, a ordem dos arquivos (raso primeiro) se mantém.
  tema.sort((a, b) => a.rank - b.rank)
  return { marca, tema: tema.map(({ color, file }) => ({ color, file })), themeColor }
}

/** Uma amostra para o histograma: cor e peso. */
export interface ColorSample {
  color: Rgb
  weight: number
}

const BINS = 36
const WINDOW_DEG = 15

/**
 * A cor dominante de um conjunto de amostras: histograma de matiz (36 faixas de
 * 10°, suavizado com as vizinhas), pesado pelo croma; a cor é a média ponderada
 * das amostras a até 15° do centro vencedor. Amostras inaceitáveis (quase
 * branco/preto, cinza) já devem ter ficado de fora.
 */
export function dominantColor(samples: readonly ColorSample[]): Rgb | null {
  if (samples.length === 0) return null
  const hues = samples.map((s) => rgbToHsl(s.color).h)
  const bins = new Array<number>(BINS).fill(0)
  samples.forEach((s, i) => {
    bins[Math.floor(hues[i] / (360 / BINS)) % BINS] += s.weight
  })
  let best = 0
  let bestWeight = -1
  for (let i = 0; i < BINS; i++) {
    const w = bins[(i + BINS - 1) % BINS] + bins[i] + bins[(i + 1) % BINS]
    if (w > bestWeight) {
      bestWeight = w
      best = i
    }
  }
  if (bestWeight <= 0) return null
  const center = (best + 0.5) * (360 / BINS)
  let r = 0
  let g = 0
  let b = 0
  let total = 0
  samples.forEach((s, i) => {
    if (hueDistance(hues[i], center) > WINDOW_DEG) return
    r += s.color.r * s.weight
    g += s.color.g * s.weight
    b += s.color.b * s.weight
    total += s.weight
  })
  return total > 0 ? { r: r / total, g: g / total, b: b / total } : null
}

/** Fração mínima dos pixels opacos que precisa ter cor (logo preto e branco não tem cor). */
const MIN_COLORED_SHARE = 0.03

/** A cor dominante de uma imagem decodificada (ignora transparente, quase branco/preto e cinza). */
export function dominantPixelColor(pixels: Pixels): Rgb | null {
  const { data } = pixels
  const samples: ColorSample[] = []
  let opaque = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    opaque++
    const color = { r: data[i], g: data[i + 1], b: data[i + 2] }
    if (isAcceptableColor(color)) samples.push({ color, weight: chroma(color) })
  }
  if (opaque === 0 || samples.length / opaque < MIN_COLORED_SHARE) return null
  return dominantColor(samples)
}

/**
 * As cores de um SVG (atributos e `style` de `fill`/`stroke`/`stop-color`).
 * Um `fill="url(#id)"` conta de novo as paradas do gradiente `id`.
 */
export function svgColorSamples(svg: string): ColorSample[] {
  const gradients = new Map<string, Rgba[]>()
  for (const m of svg.matchAll(/<(linearGradient|radialGradient)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const id = /\bid\s*=\s*["']([^"']+)["']/.exec(m[2])?.[1]
    if (!id) continue
    const stops: Rgba[] = []
    for (const s of m[3].matchAll(/stop-color\s*[:=]\s*["']?([^"';>\s]+(?:\([^)]*\))?)/gi)) {
      const c = parseCssColor(s[1])
      if (c) stops.push(c)
    }
    gradients.set(id, stops)
  }
  const colors: Rgba[] = []
  for (const m of svg.matchAll(/\b(fill|stroke|stop-color)\s*[:=]\s*["']?\s*(url\(\s*#[^)]+\)|[^"';>\s]+(?:\([^)]*\))?)/gi)) {
    const value = m[2]
    const ref = /^url\(\s*#([^)\s]+)\s*\)$/.exec(value)
    if (ref) colors.push(...(gradients.get(ref[1]) ?? []))
    else {
      const c = parseCssColor(value)
      if (c) colors.push(c)
    }
  }
  return colors.filter(isAcceptableColor).map((color) => ({ color, weight: chroma(color) }))
}

/** Logo e tema "concordam" quando o matiz está a até este tanto. */
const AGREE_DEG = 20

function result(c: ColorCandidate, source: ProjectColorSource): ProjectColor {
  return { hex: wearableColor(toHex(c.color), source), source, file: c.file }
}

/** A cor do projeto pelas fontes, na ordem; null = nenhuma aceitável (o chamador usa a reserva). */
export function decideProjectColor(input: DetectionInput): ProjectColor | null {
  const ok = (c: ColorCandidate): boolean => isAcceptableColor(c.color)
  const marca = input.marca.find(ok)
  if (marca) return result(marca, 'marca')
  const tema = input.tema.find(ok)
  if (input.logo && ok(input.logo)) {
    const logoHue = rgbToHsl(input.logo.color).h
    const agree = input.tema.find((t) => ok(t) && hueDistance(rgbToHsl(t.color).h, logoHue) <= AGREE_DEG)
    return agree ? result(agree, 'tema') : result(input.logo, 'logo')
  }
  if (tema) return result(tema, 'tema')
  const themeColor = input.themeColor.find(ok)
  return themeColor ? result(themeColor, 'tema') : null
}
