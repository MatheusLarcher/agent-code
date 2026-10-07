// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectProjectColor, scanThemeFiles, type DecodeImage } from './projectColorScan'
import { bgraPremultipliedToRgba } from './projectColorImage'
import { wearableColor } from '../shared/projectColor'

vi.mock('electron', () => ({ nativeImage: {} }))

let root = ''
const put = (rel: string, content: string | Buffer = 'x'): void => {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

/** Decodificador falso: um PNG "sintético" de 4×4 todo na cor dada. */
const solid = (r: number, g: number, b: number): DecodeImage =>
  vi.fn(async () => ({ width: 4, height: 4, data: Uint8Array.from({ length: 64 }, (_, i) => [r, g, b, 255][i % 4]) }))
const none: DecodeImage = async () => null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-code-color-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('detectProjectColor (disco)', () => {
  it('pasta vazia ou inexistente → null', async () => {
    expect(await detectProjectColor(root, none)).toBeNull()
    expect(await detectProjectColor(join(root, 'nao-existe'), none)).toBeNull()
  })

  it('logo PNG pelo decodificador injetado vence o tema', async () => {
    put('public/logo.png', Buffer.from([1, 2, 3]))
    put('src/index.css', ':root { --primary: #059669; }')
    const decode = solid(37, 99, 235)
    expect(await detectProjectColor(root, decode)).toEqual({ hex: '#2563eb', source: 'logo', file: 'public/logo.png' })
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ mime: 'image/png' }))
  })

  it('logo que não decodifica (WebP/ICO fora do Windows) cai para o tema', async () => {
    put('public/logo.webp', Buffer.from([1]))
    put('frontend/src/styles/index.css', ':root { --primary: #059669; }')
    expect(await detectProjectColor(root, none)).toEqual({
      hex: '#059669',
      source: 'tema',
      file: 'frontend/src/styles/index.css'
    })
  })

  it('marca no index.html vence o logo', async () => {
    put('favicon.png', Buffer.from([1]))
    put('index.html', '<style>:root{--brand:#0FA3E0}</style>')
    expect(await detectProjectColor(root, solid(37, 99, 235))).toMatchObject({ hex: '#0fa3e0', source: 'marca' })
  })

  it('não entra em node_modules/dist nem em pasta que não é de tema', async () => {
    put('node_modules/lib/index.css', ':root { --brand: #ff0000; }')
    put('dist/app.css', ':root { --brand: #ff0000; }')
    put('qualquer/coisa.css', ':root { --brand: #ff0000; }')
    put('android/app/src/main/res/values/colors.xml', '<color name="colorPrimary">#FF6200EE</color>')
    const files = await scanThemeFiles(root)
    expect(files.map((f) => f.rel)).toEqual(['android/app/src/main/res/values/colors.xml'])
    expect(await detectProjectColor(root, none)).toMatchObject({ hex: wearableColor('#6200ee'), source: 'tema' })
  })
})

describe('bgraPremultipliedToRgba', () => {
  it('troca B↔R e desfaz a pré-multiplicação', () => {
    expect([...bgraPremultipliedToRgba(Uint8Array.from([50, 25, 100, 128, 0, 0, 0, 0]))]).toEqual([199, 50, 100, 128, 0, 0, 0, 0])
  })
})

/**
 * SÓ LEITURA nos projetos reais do usuário (C:\GitHub). Pula o projeto que não
 * existir nesta máquina. Logo raster: decodificado por `pngjs` se estiver
 * instalado (no app é o nativeImage); ICO não decodifica aqui.
 */
async function pngDecoder(): Promise<DecodeImage> {
  try {
    const name = 'pngjs'
    const mod = (await import(/* @vite-ignore */ name)) as {
      PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } }
    }
    return async ({ mime, bytes }) => {
      if (mime !== 'image/png') return null
      const png = mod.PNG.sync.read(bytes)
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
    }
  } catch {
    return none
  }
}

const REAL: Array<[string, (c: { hex: string; source: string }) => void]> = [
  ['larchertech-site', (c) => expect(c).toMatchObject({ hex: '#0fa3e0', source: 'marca' })],
  // Aqui o ICO (frontend/icone.ico) não decodifica, então vale o --primary. No app
  // (nativeImage lê ICO no Windows) o logo vem antes do tema: azul #297ff3.
  ['pdv_gambetto', (c) => expect(c).toMatchObject({ hex: '#059669', source: 'tema' })],
  ['agent-code', (c) => expect(c.hex).toBe('#d97757')],
  // theme-color #070914 (fundo) descartado: logo SVG índigo + primary do Tailwind (#6366f1).
  ['crm', (c) => expect(c.hex).not.toBe('#070914')]
]

describe('projetos reais (só leitura)', () => {
  for (const [name, check] of REAL) {
    const dir = join('C:\\GitHub', name)
    it.skipIf(!existsSync(dir))(name, async () => {
      const color = await detectProjectColor(dir, await pngDecoder())
      expect(color).not.toBeNull()
      check(color!)
    }, 30_000)
  }
})
