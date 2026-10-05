import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import { decodePairing } from './decode'

/** O QR como o PC desenha (RemoteModal: URL pública + ?token + ?lan), rasterizado em RGBA como um quadro da câmera. */
function qrFrame(text: string, scale = 4, quiet = 4): { data: Uint8ClampedArray; size: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const size = (n + quiet * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
  }
  return { data, size }
}

describe('leitura do QR do PC', () => {
  it('decodifica a URL pública com token e LAN', () => {
    const f = qrFrame('https://agent-code.larchertech.com/?token=0123456789abcdef0123456789abcdef&lan=192.168.0.179%3A8765')
    expect(decodePairing(f.data, f.size, f.size)).toEqual({
      base: 'https://agent-code.larchertech.com',
      token: '0123456789abcdef0123456789abcdef',
      lan: '192.168.0.179:8765'
    })
  })

  it('QR que não é da ponte (sem token) não pareia', () => {
    const f = qrFrame('https://example.com/qualquer')
    expect(decodePairing(f.data, f.size, f.size)).toBeNull()
  })

  it('quadro sem QR não pareia', () => {
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(200)
    expect(decodePairing(blank, 64, 64)).toBeNull()
  })
})
