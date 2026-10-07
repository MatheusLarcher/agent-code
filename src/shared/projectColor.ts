/**
 * A cor do projeto (etapa "cor-do-projeto"): uma cor FIXA por projeto, detectada
 * no main (src/main/projectColor*.ts) a partir da marca, do logo ou do tema do
 * projeto e gravada no KV global. Este módulo é puro e vale para main, renderer e
 * celular: tipos, a paleta de reserva, o critério de cor "aceitável" e o ajuste
 * "vestível" (camisa e ponto sobre o fundo escuro do app).
 */

/** De onde a cor veio. `reserva` = nenhuma fonte deu cor aceitável (hash da identidade). */
export type ProjectColorSource = 'marca' | 'logo' | 'tema' | 'reserva'

export interface ProjectColor {
  /** `#rrggbb` minúsculo, já vestível — é a cor a pintar. */
  hex: string
  source: ProjectColorSource
  /** Arquivo de onde a cor saiu, relativo à raiz do projeto (`/`), quando houver. */
  file?: string
}

/** Cor do projeto por cwd (o formato que o IPC e o `/api/state` devolvem). */
export type ProjectColorMap = Record<string, ProjectColor>

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Rgb + alfa 0..1 (o que os leitores de CSS/SVG devolvem antes do critério). */
export interface Rgba extends Rgb {
  a: number
}

export interface Hsl {
  /** 0..360 */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  l: number
}

/**
 * As 12 cores de reserva, por matiz (52°→325°). O laranja do app (#d97757,
 * matiz ≈15°) é da Central: nenhuma reserva chega a 30° dele (mesma regra de
 * renderer/src/central/centralColor.ts). Todas já são vestíveis.
 */
export const PROJECT_RESERVE_PALETTE: readonly string[] = [
  '#ddc52c',
  '#8eba36',
  '#55bf40',
  '#3cb464',
  '#2bab8b',
  '#2cacba',
  '#3c9add',
  '#557ae7',
  '#7f70e1',
  '#a264d8',
  '#c65ec9',
  '#dd5fa9'
]

/** Cor constante do Sandbox (todas as pastas de sandbox são um projeto só): ardósia. */
export const SANDBOX_PROJECT_COLOR: ProjectColor = { hex: '#8fa3bf', source: 'reserva' }

/** Pasta de sandbox `<localDir>\sandbox\AAAA-MM-DD_HH-MM_<4 hex>` (main/sandbox.ts), pelo caminho. */
const SANDBOX_DIR = /[\\/]sandbox[\\/]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_[0-9a-f]{4}(?:[\\/]|$)/i

export function isSandboxProjectPath(cwd: string): boolean {
  return SANDBOX_DIR.test(cwd)
}

/** FNV-1a 32 bits + fmix32 do MurmurHash3 (o mesmo de centralColor.ts). */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A cor de reserva de `key` (a identidade do projeto): estável em qualquer PC. */
export function reserveProjectColor(key: string): string {
  return PROJECT_RESERVE_PALETTE[hash(key) % PROJECT_RESERVE_PALETTE.length]
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** `#rgb`, `#rgba`, `#rrggbb` ou `#rrggbbaa` (CSS) → Rgba; null se não for hex. */
export function parseHex(text: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim())
  if (!m) return null
  let h = m[1]
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s: clamp01(s), l }
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/** Luminância relativa (WCAG) 0..1. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Croma 0..1 (max − min dos canais): quanto de "cor" há, independente da luz. */
export function chroma({ r, g, b }: Rgb): number {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}

/**
 * Uma cor serve de cor de projeto? Descarta transparente (alfa < 0,5), quase
 * branco (L > 0,92), quase preto (L < 0,12) e cinza/pouca saturação (croma < 0,15
 * ou S < 0,25). É o que separa a cor da marca do FUNDO que `theme-color`
 * costuma trazer (#070914, #F4F5F3…).
 */
export function isAcceptableColor(color: Rgba | Rgb): boolean {
  if ('a' in color && color.a < 0.5) return false
  const { s, l } = rgbToHsl(color)
  if (l > 0.92 || l < 0.12) return false
  return chroma(color) >= 0.15 && s >= 0.25
}

/** Faixa de luminância vestível: lê como ponto sobre o fundo escuro e não some na camisa. */
const MIN_LUMINANCE = 0.12
const MAX_LUMINANCE = 0.62
const MIN_SATURATION = 0.4

/**
 * A cor pronta para a camisa e para o ponto sobre o fundo escuro do app: mantém
 * o matiz e mexe na saturação/luz SÓ o necessário (S ≥ 0,4; luminância entre
 * 0,12 e 0,62). Cor de marca (`source === 'marca'`) não é desviada. Hex inválido
 * volta como veio.
 */
export function wearableColor(hex: string, source?: ProjectColorSource): string {
  const rgba = parseHex(hex)
  if (!rgba) return hex
  if (source === 'marca') return toHex(rgba)
  const hsl = rgbToHsl(rgba)
  if (hsl.s < MIN_SATURATION) hsl.s = MIN_SATURATION
  let rgb = hslToRgb(hsl)
  const y = luminance(rgb)
  if (y < MIN_LUMINANCE || y > MAX_LUMINANCE) {
    // Busca binária na luz (L), matiz e saturação fixos, até a borda da faixa:
    // `lo` fica sempre do lado escuro do alvo e `hi` do lado claro.
    const dark = y < MIN_LUMINANCE
    const target = dark ? MIN_LUMINANCE : MAX_LUMINANCE
    let lo = dark ? hsl.l : 0
    let hi = dark ? 1 : hsl.l
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (luminance(hslToRgb({ ...hsl, l: mid })) < target) lo = mid
      else hi = mid
    }
    rgb = hslToRgb({ ...hsl, l: dark ? hi : lo })
  }
  return toHex(rgb)
}

/** Distância de matiz em graus (0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Valida um `ProjectColor` vindo de fora (KV, ponte): forma e hex. */
export function isProjectColor(value: unknown): value is ProjectColor {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.hex === 'string' &&
    /^#[0-9a-f]{6}$/.test(v.hex) &&
    (v.source === 'marca' || v.source === 'logo' || v.source === 'tema' || v.source === 'reserva') &&
    (v.file === undefined || typeof v.file === 'string')
  )
}
