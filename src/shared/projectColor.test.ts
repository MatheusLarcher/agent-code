import { describe, it, expect } from 'vitest'
import {
  PROJECT_RESERVE_PALETTE,
  hueDistance,
  isAcceptableColor,
  isProjectColor,
  isSandboxProjectPath,
  luminance,
  parseHex,
  reserveProjectColor,
  rgbToHsl,
  wearableColor
} from './projectColor'

const hueOf = (hex: string): number => rgbToHsl(parseHex(hex)!).h
const ORANGE_HUE = hueOf('#d97757')

describe('paleta de reserva', () => {
  it('tem 12 cores distintas, todas longe (≥30°) do laranja da Central', () => {
    expect(new Set(PROJECT_RESERVE_PALETTE).size).toBe(12)
    for (const hex of PROJECT_RESERVE_PALETTE) expect(hueDistance(hueOf(hex), ORANGE_HUE)).toBeGreaterThanOrEqual(30)
  })

  it('todas já são aceitáveis e vestíveis (o ajuste não as muda)', () => {
    for (const hex of PROJECT_RESERVE_PALETTE) {
      expect(isAcceptableColor(parseHex(hex)!)).toBe(true)
      expect(wearableColor(hex)).toBe(hex)
    }
  })

  it('reserveProjectColor é estável e espalha chaves diferentes', () => {
    expect(reserveProjectColor('abc')).toBe(reserveProjectColor('abc'))
    const used = new Set(Array.from({ length: 60 }, (_, i) => reserveProjectColor(`projeto-${i}`)))
    expect(used.size).toBeGreaterThanOrEqual(8)
    for (const hex of used) expect(PROJECT_RESERVE_PALETTE).toContain(hex)
  })
})

describe('isAcceptableColor', () => {
  it.each([
    ['#070914', false], // fundo escuro (crm)
    ['#050c16', false], // fundo escuro (baixar_xml_nfse)
    ['#F4F5F3', false], // fundo claro (larchertech)
    ['#f4f3ed', false], // fundo claro (OpenDub)
    ['#808080', false], // cinza
    ['#0f172a', false], // azul-marinho quase preto (primary padrão do shadcn)
    ['#0FA3E0', true],
    ['#059669', true],
    ['#d97757', true]
  ])('%s → %s', (hex, ok) => {
    expect(isAcceptableColor(parseHex(hex)!)).toBe(ok)
  })

  it('descarta transparente', () => {
    expect(isAcceptableColor({ r: 15, g: 163, b: 224, a: 0.2 })).toBe(false)
  })
})

describe('wearableColor', () => {
  it('não mexe no que já é legível (agent-code fica #d97757)', () => {
    expect(wearableColor('#d97757')).toBe('#d97757')
    expect(wearableColor('#059669')).toBe('#059669')
  })

  it('cor de marca nunca é desviada', () => {
    expect(wearableColor('#1e3a8a', 'marca')).toBe('#1e3a8a')
  })

  it('escuro demais clareia mantendo o matiz', () => {
    const out = wearableColor('#1e3a8a')
    expect(out).not.toBe('#1e3a8a')
    expect(luminance(parseHex(out)!)).toBeGreaterThanOrEqual(0.119)
    expect(hueDistance(hueOf(out), hueOf('#1e3a8a'))).toBeLessThan(2)
  })

  it('claro demais escurece; pouca saturação ganha saturação', () => {
    const pale = wearableColor('#c8f7c5')
    expect(luminance(parseHex(pale)!)).toBeLessThanOrEqual(0.621)
    expect(rgbToHsl(parseHex(wearableColor('#7a8f9e'))!).s).toBeGreaterThanOrEqual(0.39)
  })

  it('hex inválido volta como veio', () => {
    expect(wearableColor('azul')).toBe('azul')
  })
})

describe('auxiliares', () => {
  it('isSandboxProjectPath reconhece a pasta de sandbox', () => {
    expect(isSandboxProjectPath('C:\\Users\\x\\AppData\\agent\\sandbox\\2026-10-06_09-03_f38b')).toBe(true)
    expect(isSandboxProjectPath('C:\\GitHub\\agent-code')).toBe(false)
  })

  it('isProjectColor valida a forma', () => {
    expect(isProjectColor({ hex: '#0fa3e0', source: 'marca', file: 'index.html' })).toBe(true)
    expect(isProjectColor({ hex: '#0FA3E0', source: 'marca' })).toBe(false)
    expect(isProjectColor({ hex: '#0fa3e0', source: 'outra' })).toBe(false)
    expect(isProjectColor(null)).toBe(false)
  })
})
