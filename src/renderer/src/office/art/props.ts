import type { PropKind } from '../engine/types'
import type { OfficePalette, PaletteKey } from './palette'

/**
 * Objetos de mão/cabeça. g=lente h=cabo p=celular c=tela z=sono
 * f=capa da pasta (a cor do projeto entra por cima) w=papel e=borda do papel
 * v=✓ verde x=✗ vermelho m=pele da mão.
 */
export const PROP_KEYS: Readonly<Record<string, PaletteKey>> = {
  g: 'lens',
  h: 'handle',
  p: 'phone',
  c: 'phoneScreen',
  z: 'sleep',
  f: 'amber',
  w: 'paper',
  e: 'paperEdge',
  v: 'okGreen',
  x: 'errRed',
  m: 'postPink',
  // F4·4-5: café (b) e crachá (i faixa azul, y brilho).
  b: 'coffee',
  i: 'postBlue',
  y: 'postYellow'
}

/** Letra pintada com a cor do projeto quando o adereço leva tint. */
export const PROP_TINT_KEY = 'f'

// Pasta 7×5: aba em cima, folha aparecendo; as variantes carimbam ✓ ou ✗.
const PASTA = ['ff.....', 'fffffff', 'fwwwwwf', 'fffffff', 'fffffff']
const stamp = (rows: string[], mark: 'v' | 'x'): string[] => {
  const out = [...rows]
  out[2] = mark === 'v' ? 'fwwwwvf' : 'fwwxwxf'
  out[3] = mark === 'v' ? 'ffvfvff' : 'ffffxff'
  out[4] = mark === 'v' ? 'fffvfff' : 'fffxfxf'
  return out
}
// Prancheta 5×6 com a lupa encostada embaixo à direita.
const PRANCHETA = ['.hh...', 'wwww..', 'weew..', 'wwwgg.', 'weg..g', 'wwg..g', '...gg.', '.....h']

export const PROP_ROWS: Readonly<Record<PropKind, readonly string[]>> = {
  // A lupa do protótipo.
  lupa: ['.gg..', 'g..g.', 'g..g.', '.gg..', '...hh'],
  celular: ['ppp', 'pcp', 'pcp', 'ppp'],
  zzz: ['...zzz', '....z.', 'zz.zzz', '.z....', 'zz....'],
  pasta: PASTA,
  'pasta-ok': stamp(PASTA, 'v'),
  'pasta-erro': stamp(PASTA, 'x'),
  prancheta: PRANCHETA,
  'prancheta-ok': ['.....v', '....v.', 'v..v..', '.vv...', ...PRANCHETA.slice(4)],
  'prancheta-erro': ['x...x.', '.x.x..', '..x...', '.x.x..', 'x...x.', ...PRANCHETA.slice(5)],
  // Mão levantada acima da cabeça: dedos, palma e o braço.
  mao: ['m.m.m', 'mmmmm', 'mmmmm', '.mmm.', '.hhh.', '.hhh.'],
  // Ficha de arquivo: cartão com linhas.
  ficha: ['wwwww', 'weeew', 'wwwww', 'weeew', 'wwwww'],
  // Xícara com vapor: fumacinha, borda, café, alça à direita.
  xicara: ['.e.e.', 'e.e..', 'wwww.', 'wbbww', 'wwwww', '.ww..'],
  // Crachá brilhando: aura amarela, faixa azul, foto e linhas do nome.
  cracha: ['y.hh.y', 'yiiiiy', 'ywwwwy', 'ywbeey', 'ywwwwy', 'yyyyyy']
}

export function propPalette(pal: OfficePalette): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, token] of Object.entries(PROP_KEYS)) out[k] = pal[token]
  return out
}

export const PROP_KINDS: readonly PropKind[] = [
  'celular',
  'zzz',
  'lupa',
  'pasta',
  'pasta-ok',
  'pasta-erro',
  'prancheta',
  'prancheta-ok',
  'prancheta-erro',
  'mao',
  'ficha',
  'xicara',
  'cracha'
]

/** Adereços que aceitam a cor do projeto. */
export const TINTED_PROPS: ReadonlySet<PropKind> = new Set(['pasta', 'pasta-ok', 'pasta-erro'])

/** Cores de projeto para a pasta: estáveis por sala (hash do id). */
const PROJECT_TOKENS: readonly PaletteKey[] = ['postYellow', 'postPink', 'postBlue', 'postGreen', 'amber', 'leaf']

export function projectColor(roomId: string | null, pal: OfficePalette): string {
  if (!roomId) return pal.amber
  let h = 0
  for (let i = 0; i < roomId.length; i++) h = (h * 31 + roomId.charCodeAt(i)) >>> 0
  return pal[PROJECT_TOKENS[h % PROJECT_TOKENS.length]]
}
