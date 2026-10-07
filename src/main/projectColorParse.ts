/**
 * Leitura de cores escritas em arquivos de projeto (CSS, Tailwind, MUI, Android,
 * Flutter, SVG) → Rgba. Puro, sem fs. Usado pelo detector (projectColor.ts).
 */
import { hslToRgb, parseHex, type Rgba } from '../shared/projectColor'

/** Variáveis CSS conhecidas (nome sem `--` → valor cru), para resolver `var(--x)`. */
export type CssVars = ReadonlyMap<string, string>

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`

/** Número com `%` opcional → fração do `max` (ex.: `50%` de 255 = 127,5). */
function channel(text: string, max: number): number {
  const t = text.trim()
  return t.endsWith('%') ? (Number.parseFloat(t) / 100) * max : Number.parseFloat(t)
}

function alpha(text: string | undefined): number {
  if (text === undefined) return 1
  const v = channel(text, 1)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

/** Separa os argumentos de `rgb(…)`, `hsl(…)`, `oklch(…)`: vírgulas ou espaços com `/ alfa`. */
function args(inner: string): { parts: string[]; a?: string } {
  const [main, slash] = inner.split('/')
  const parts = main.split(/[\s,]+/).filter(Boolean)
  if (slash !== undefined) return { parts, a: slash.trim() }
  if (parts.length === 4) return { parts: parts.slice(0, 3), a: parts[3] }
  return { parts }
}

function hue(text: string): number {
  const t = text.trim().toLowerCase()
  const v = Number.parseFloat(t)
  if (t.endsWith('turn')) return v * 360
  if (t.endsWith('rad')) return (v * 180) / Math.PI
  return v
}

function fromHsl(h: number, s: number, l: number, a = 1): Rgba | null {
  if (![h, s, l].every(Number.isFinite)) return null
  const rgb = hslToRgb({ h, s: Math.min(1, Math.max(0, s)), l: Math.min(1, Math.max(0, l)) })
  return { ...rgb, a }
}

/** OKLCH (CSS Color 4 / Tailwind v4 / shadcn) → sRGB. */
function fromOklch(L: number, C: number, H: number, a = 1): Rgba | null {
  if (![L, C, H].every(Number.isFinite)) return null
  const hr = (H * Math.PI) / 180
  const A = C * Math.cos(hr)
  const B = C * Math.sin(hr)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
  const [r, g, b] = lin.map((v) => {
    const c = Math.min(1, Math.max(0, v))
    return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255
  })
  return { r, g, b, a }
}

/**
 * Uma cor CSS → Rgba, ou null. Aceita hex, `rgb()/rgba()`, `hsl()/hsla()`,
 * `oklch()`, `var(--x, fallback)` (resolvido em `vars`), e as formas "nuas" que
 * os temas guardam em variáveis: `222.2 47.4% 11.2%` (HSL do shadcn) e
 * `59 130 246` (RGB do Tailwind). Nomes de cor (`red`) não contam.
 */
export function parseCssColor(raw: string, vars?: CssVars, depth = 0): Rgba | null {
  const text = raw.trim().replace(/\s*!important$/i, '')
  if (!text || depth > 4) return null
  const hex = parseHex(text)
  if (hex) return hex

  const v = /^var\(\s*--([\w-]+)\s*(?:,\s*(.+))?\)$/i.exec(text)
  if (v) {
    const value = vars?.get(v[1])
    const resolved = value !== undefined ? parseCssColor(value, vars, depth + 1) : null
    return resolved ?? (v[2] ? parseCssColor(v[2], vars, depth + 1) : null)
  }

  const fn = /^(rgba?|hsla?|oklch)\(\s*(.+?)\s*\)$/i.exec(text)
  if (fn) {
    const name = fn[1].toLowerCase()
    const { parts, a } = args(fn[2])
    if (parts.length !== 3) return null
    if (name.startsWith('rgb')) {
      const [r, g, b] = parts.map((p) => channel(p, 255))
      return [r, g, b].every(Number.isFinite) ? { r, g, b, a: alpha(a) } : null
    }
    if (name.startsWith('hsl')) {
      return fromHsl(hue(parts[0]), channel(parts[1], 100) / 100, channel(parts[2], 100) / 100, alpha(a))
    }
    const L = parts[0].endsWith('%') ? Number.parseFloat(parts[0]) / 100 : Number.parseFloat(parts[0])
    const C = parts[1].endsWith('%') ? (Number.parseFloat(parts[1]) / 100) * 0.4 : Number.parseFloat(parts[1])
    return fromOklch(L, C, hue(parts[2]), alpha(a))
  }

  const bareHsl = new RegExp(`^(${NUM})(?:deg)?\\s+(${NUM})%\\s+(${NUM})%$`).exec(text)
  if (bareHsl) {
    return fromHsl(Number(bareHsl[1]), Number(bareHsl[2]) / 100, Number(bareHsl[3]) / 100)
  }
  const bareRgb = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/.exec(text)
  if (bareRgb) {
    const [r, g, b] = bareRgb.slice(1, 4).map(Number)
    return r <= 255 && g <= 255 && b <= 255 ? { r, g, b, a: 1 } : null
  }
  return null
}

/** `#AARRGGBB` / `#RRGGBB` / `#RGB` do Android (o alfa vem PRIMEIRO). */
export function parseAndroidColor(raw: string): Rgba | null {
  const text = raw.trim()
  const argb = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(text)
  if (argb) {
    const rgb = parseHex(`#${argb[2]}`)
    return rgb ? { ...rgb, a: Number.parseInt(argb[1], 16) / 255 } : null
  }
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? parseHex(text) : null
}

/** As cores primárias do Material (`Colors.blue` no Flutter). */
const FLUTTER_COLORS: Record<string, string> = {
  red: '#f44336',
  pink: '#e91e63',
  purple: '#9c27b0',
  deepPurple: '#673ab7',
  indigo: '#3f51b5',
  blue: '#2196f3',
  lightBlue: '#03a9f4',
  cyan: '#00bcd4',
  teal: '#009688',
  green: '#4caf50',
  lightGreen: '#8bc34a',
  lime: '#cddc39',
  yellow: '#ffeb3b',
  amber: '#ffc107',
  orange: '#ff9800',
  deepOrange: '#ff5722',
  brown: '#795548',
  blueGrey: '#607d8b'
}

/** `Color(0xFF6200EE)` (ARGB) ou `Colors.indigo` do Flutter. */
export function parseFlutterColor(raw: string): Rgba | null {
  const text = raw.trim()
  const hex = /^(?:const\s+)?Color\(\s*0x([0-9a-f]{2})([0-9a-f]{6})\s*\)$/i.exec(text)
  if (hex) {
    const rgb = parseHex(`#${hex[2]}`)
    return rgb ? { ...rgb, a: Number.parseInt(hex[1], 16) / 255 } : null
  }
  const named = /^(?:const\s+)?Colors\.(\w+?)(?:\.shade\d+|\[\d+\])?$/.exec(text)
  return named && FLUTTER_COLORS[named[1]] ? parseHex(FLUTTER_COLORS[named[1]]) : null
}
