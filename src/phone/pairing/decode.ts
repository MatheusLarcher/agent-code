/** QR lido de um quadro da câmera → pareamento, ou null (sem QR, ou QR que não é da ponte). */
import jsQR from 'jsqr'
import { parseConfig, type PairConfig } from '../core/config'

export function decodePairing(rgba: Uint8ClampedArray, width: number, height: number): PairConfig | null {
  const code = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' })
  if (!code?.data) return null
  const cfg = parseConfig(code.data)
  return cfg.base && cfg.token ? cfg : null
}
