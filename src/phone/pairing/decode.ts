/** QR lido de um quadro da câmera: o pareamento da ponte, um QR legível que é de outra coisa, ou nenhum QR. */
import jsQR from 'jsqr'
import { parseConfig, type PairConfig } from '../core/config'

/** `{ cfg }` = QR da ponte; `{ foreign: true }` = leu um QR, mas não é de uma ponte; `null` = quadro sem QR. */
export type FrameResult = { cfg: PairConfig } | { foreign: true } | null

export function decodeFrame(rgba: Uint8ClampedArray, width: number, height: number): FrameResult {
  const code = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' })
  if (!code?.data) return null
  const cfg = parseConfig(code.data)
  return cfg.base && cfg.token ? { cfg } : { foreign: true }
}

/** Só o pareamento: o QR de outra coisa e o quadro sem QR dão null. */
export function decodePairing(rgba: Uint8ClampedArray, width: number, height: number): PairConfig | null {
  const r = decodeFrame(rgba, width, height)
  return r && 'cfg' in r ? r.cfg : null
}
