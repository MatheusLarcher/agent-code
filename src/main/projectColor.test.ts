// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { toHex, wearableColor } from '../shared/projectColor'
import {
  collectCandidates,
  decideProjectColor,
  dominantPixelColor,
  svgColorSamples,
  dominantColor,
  type ScannedFile
} from './projectColor'
import { parseCssColor } from './projectColorParse'

const detect = (files: ScannedFile[]) => decideProjectColor({ ...collectCandidates(files), logo: null })
const hexOf = (c: ReturnType<typeof parseCssColor>): string | null => (c ? toHex(c) : null)

describe('parseCssColor', () => {
  it.each([
    ['#0FA3E0', '#0fa3e0'],
    ['#abc', '#aabbcc'],
    ['rgb(5, 150, 105)', '#059669'],
    ['rgb(5 150 105 / 50%)', '#059669'],
    ['hsl(160, 84%, 39%)', '#10b981'],
    ['160 84% 39%', '#10b981'],
    ['5 150 105', '#059669'],
    ['oklch(59.6% 0.145 163.225)', '#009966']
  ])('%s → %s', (text, hex) => {
    const out = hexOf(parseCssColor(text))
    // oklch/hsl arredondam: compara com tolerância de 3 por canal.
    const want = parseCssColor(hex)!
    const got = parseCssColor(out!)!
    expect(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b)).toBeLessThanOrEqual(9)
  })

  it('resolve var(--x) e o fallback', () => {
    const vars = new Map([['emerald', '#059669']])
    expect(hexOf(parseCssColor('var(--emerald)', vars))).toBe('#059669')
    expect(hexOf(parseCssColor('var(--nao-tem, #0fa3e0)', vars))).toBe('#0fa3e0')
    expect(parseCssColor('red')).toBeNull()
  })
})

describe('fontes de texto', () => {
  it('marca: --brand no <style> do index.html vence o --accent', () => {
    const html = '<style>:root{--brand:#0FA3E0;--accent:#07A06B}</style><meta name="theme-color" content="#F4F5F3">'
    expect(detect([{ rel: 'index.html', text: html }])).toEqual({ hex: '#0fa3e0', source: 'marca', file: 'index.html' })
  })

  it('tema: --primary vence --accent, mesmo em arquivo mais fundo', () => {
    const files = [
      { rel: 'src/index.css', text: ':root { --accent: #34d399; }' },
      { rel: 'frontend/src/styles/index.css', text: ':root {\n  --primary: #059669;\n  --accent: #34d399;\n}' }
    ]
    expect(detect(files)).toEqual({ hex: '#059669', source: 'tema', file: 'frontend/src/styles/index.css' })
  })

  it('tema: --accent sozinho (agent-code)', () => {
    expect(detect([{ rel: 'src/renderer/src/styles.css', text: ':root { --bg: #1a1a1a; --accent: #d97757; }' }])?.hex).toBe(
      '#d97757'
    )
  })

  it('tema: --primary do shadcn quase preto é descartado; segue para a próxima fonte', () => {
    const files = [
      { rel: 'src/index.css', text: ':root { --primary: 222.2 47.4% 11.2%; } .dark { --primary: 210 40% 98%; }' },
      { rel: 'public/manifest.json', text: '{ "theme_color": "#7c3aed" }' }
    ]
    expect(detect(files)).toEqual({ hex: '#7c3aed', source: 'tema', file: 'public/manifest.json' })
  })

  it('tailwind.config: primary com DEFAULT/500 e brand como marca', () => {
    const tw = `module.exports = { theme: { extend: { colors: { primary: { 50: '#eff6ff', 500: '#3b82f6', 900: '#1e3a8a' } } } } }`
    expect(detect([{ rel: 'tailwind.config.js', text: tw }])).toEqual({ hex: '#3b82f6', source: 'tema', file: 'tailwind.config.js' })
    const brand = `export default { theme: { colors: { brand: '#e11d48', primary: '#3b82f6' } } }`
    expect(detect([{ rel: 'tailwind.config.ts', text: brand }])?.source).toBe('marca')
  })

  it('MUI createTheme', () => {
    const ts = `export const theme = createTheme({ palette: { primary: { main: '#1976d2' }, secondary: { main: '#9c27b0' } } })`
    expect(detect([{ rel: 'src/theme.ts', text: ts }])).toEqual({ hex: '#1976d2', source: 'tema', file: 'src/theme.ts' })
  })

  it('colors.xml do Android (#AARRGGBB)', () => {
    const xml = '<resources>\n  <color name="colorPrimary">#FF6200EE</color>\n  <color name="white">#FFFFFFFF</color>\n</resources>'
    // #6200ee é escuro demais para o fundo do app: sai vestível (mesmo matiz, mais claro).
    expect(detect([{ rel: 'android/app/src/main/res/values/colors.xml', text: xml }])?.hex).toBe(wearableColor('#6200ee'))
  })

  it('Flutter seedColor (Color e Colors.x)', () => {
    expect(detect([{ rel: 'lib/main.dart', text: 'ColorScheme.fromSeed(seedColor: const Color(0xFF00897B)),' }])?.hex).toBe('#00897b')
    expect(detect([{ rel: 'lib/theme.dart', text: 'ColorScheme.fromSeed(seedColor: Colors.indigo),' }])?.hex).toBe(
      wearableColor('#3f51b5')
    )
  })

  it('theme-color de FUNDO é descartado → null (o chamador usa a reserva)', () => {
    const files = [
      { rel: 'frontend/index.html', text: '<meta name="theme-color" content="#070914" />' },
      { rel: 'frontend/public/site.webmanifest', text: '{"theme_color":"#070914","background_color":"#070914"}' }
    ]
    expect(detect(files)).toBeNull()
  })
})

describe('logo', () => {
  it('SVG: cores de fill/stop-color, gradiente por url(#id), branco ignorado', () => {
    const svg = `<svg><defs><linearGradient id="brand"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs>
      <rect fill="url(#brand)"/><text fill="white">CRM</text></svg>`
    const rgb = dominantColor(svgColorSamples(svg))!
    expect(rgb.b).toBeGreaterThan(rgb.r)
    expect(rgb.b).toBeGreaterThan(rgb.g)
  })

  it('pixels: transparente, quase branco/preto e cinza ficam de fora; vence a cor pesada por saturação', () => {
    const px: number[] = []
    const put = (n: number, r: number, g: number, b: number, a = 255): void => {
      for (let i = 0; i < n; i++) px.push(r, g, b, a)
    }
    put(400, 0, 0, 0, 0) // transparente
    put(300, 250, 250, 250) // quase branco
    put(200, 30, 30, 30) // quase preto
    put(100, 128, 128, 128) // cinza
    put(80, 217, 119, 87) // laranja
    put(20, 59, 130, 246) // azul (menos)
    const rgb = dominantPixelColor({ width: 1100, height: 1, data: Uint8Array.from(px) })!
    expect(toHex(rgb)).toBe('#d97757')
  })

  it('logo preto e branco não tem cor', () => {
    const data = new Uint8Array(400).fill(255)
    expect(dominantPixelColor({ width: 10, height: 10, data })).toBeNull()
  })

  it('logo vence tema; logo e tema no mesmo matiz → vale o hex exato do tema', () => {
    const tema = [{ color: parseCssColor('#d97757')!, file: 'src/styles.css' }]
    const logoLaranja = { color: { r: 222, g: 125, b: 92, a: 1 }, file: 'build/icon.png' }
    expect(decideProjectColor({ marca: [], tema, themeColor: [], logo: logoLaranja })).toEqual({
      hex: '#d97757',
      source: 'tema',
      file: 'src/styles.css'
    })
    const logoAzul = { color: parseCssColor('#2563eb')!, file: 'public/logo.svg' }
    expect(decideProjectColor({ marca: [], tema, themeColor: [], logo: logoAzul })).toEqual({
      hex: '#2563eb',
      source: 'logo',
      file: 'public/logo.svg'
    })
  })
})
