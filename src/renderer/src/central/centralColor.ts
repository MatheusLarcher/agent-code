/**
 * A cor de reserva de um destino da Central SEM projeto conhecido (a cor normal
 * é a do projeto — centralRecents.ts `labelFor`): um "fio" por conversa. Módulo
 * puro, sem React.
 *
 * O laranja do app (`--accent`, #d97757, matiz ≈15°) é EXCLUSIVO da Central:
 * nenhuma cor daqui chega a 30° dele, senão o destino pareceria a própria Central.
 */

/** As 8 cores, nesta ordem: azul, roxo, verde, amarelo, turquesa, rosa, lima, lavanda. */
export const CENTRAL_PALETTE: readonly string[] = [
  '#7fb3d5',
  '#c39bd3',
  '#8fc89a',
  '#e0cf7a',
  '#6cc4c0',
  '#e39bc1',
  '#a3c46c',
  '#9aa8e8'
]

/**
 * FNV-1a de 32 bits sobre as unidades UTF-16 do id, com a mistura final do
 * MurmurHash3 (fmix32). Sem ela, o último caractere quase não mexe no hash: os 3
 * bits de baixo só enxergam os 3 bits de baixo de cada caractere, e os de cima
 * só mudam por "vai um" — ids que diferem no fim (o sufixo aleatório do `uid`)
 * caíam todos na mesma cor.
 */
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

/** A cor da conversa `convId`: estável (o mesmo id dá sempre a mesma cor). */
export function centralColor(convId: string): string {
  return CENTRAL_PALETTE[hash(convId) % CENTRAL_PALETTE.length]
}
