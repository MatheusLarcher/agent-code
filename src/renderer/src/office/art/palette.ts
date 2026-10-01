/**
 * Paleta do escritório (do protótipo 44ea8e-escritorio-estilo.html). Todo
 * sprite da arte sai daqui: trocar um token recolore o escritório inteiro.
 */
export interface OfficePalette {
  wall: string
  wallHi: string
  wallLo: string
  floorA: string
  floorB: string
  desk: string
  deskEdge: string
  monOff: string
  monOn: string
  chair: string
  chairBack: string
  table: string
  tableEdge: string
  board: string
  boardLine: string
  paper: string
  paperEdge: string
  printer: string
  printerLo: string
  led: string
  bubble: string
  bubbleEdge: string
  add: string
  del: string
  code: string
  legs: string
  amber: string
  okGreen: string
  errRed: string
  postYellow: string
  postPink: string
  postBlue: string
  postGreen: string
  steel: string
  steelLo: string
  coffee: string
  pot: string
  leaf: string
  leafLo: string
  rug: string
  rugEdge: string
  lens: string
  handle: string
  phone: string
  phoneScreen: string
  sleep: string
}

export const PALETTE: Readonly<OfficePalette> = {
  wall: '#34344f',
  wallHi: '#45456a',
  wallLo: '#2a2a40',
  floorA: '#262640',
  floorB: '#2a2a46',
  desk: '#a07c50',
  deskEdge: '#7f613d',
  monOff: '#3a6ea5',
  monOn: '#10203a',
  chair: '#3c3c5c',
  chairBack: '#4a4a70',
  table: '#6e4c2c',
  tableEdge: '#56391f',
  board: '#d9d2c0',
  boardLine: '#b9b19c',
  paper: '#e9e6dc',
  paperEdge: '#bdb8a8',
  printer: '#8a8fa3',
  printerLo: '#6d7286',
  led: '#7fd67f',
  bubble: '#eceef4',
  bubbleEdge: '#9aa0b4',
  add: '#7fd67f',
  del: '#e06c6c',
  code: '#cfd3dc',
  legs: '#23233a',
  amber: '#e0a458',
  okGreen: '#4fb34f',
  errRed: '#d9534f',
  postYellow: '#e8c95a',
  postPink: '#e89a9a',
  postBlue: '#9ad0e8',
  postGreen: '#9ae8a8',
  steel: '#8a8fa3',
  steelLo: '#5d6276',
  coffee: '#5a3a22',
  pot: '#9a5b3a',
  leaf: '#5fae5f',
  leafLo: '#3f8a4a',
  rug: '#4a3a5c',
  rugEdge: '#3a2c4a',
  lens: '#dfe3ee',
  handle: '#8a6d4b',
  phone: '#1d1d2a',
  phoneScreen: '#6fbdad',
  sleep: '#cfd3dc'
}

export type PaletteKey = keyof OfficePalette
