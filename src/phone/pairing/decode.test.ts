import { describe, expect, it } from 'vitest'
import QRCode from 'qrcode'
import { decodeFrame, decodePairing } from './decode'

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

describe('decodeFrame: distingue "QR de outra coisa" de "sem QR"', () => {
  it('QR da ponte → { cfg }', () => {
    const f = qrFrame('https://agent-code.larchertech.com/?token=0123456789abcdef0123456789abcdef&lan=192.168.0.179%3A8765')
    expect(decodeFrame(f.data, f.size, f.size)).toEqual({
      cfg: { base: 'https://agent-code.larchertech.com', token: '0123456789abcdef0123456789abcdef', lan: '192.168.0.179:8765' }
    })
  })

  it('QR legível que não é da ponte (sem token, ou nem é endereço) → { foreign: true }', () => {
    const site = qrFrame('https://example.com/qualquer')
    expect(decodeFrame(site.data, site.size, site.size)).toEqual({ foreign: true })
    const texto = qrFrame('WIFI:S:minha-rede;T:WPA;P:senha;;')
    expect(decodeFrame(texto.data, texto.size, texto.size)).toEqual({ foreign: true })
  })

  it('quadro sem QR → null (não é "estrangeiro": ainda não há o que avisar)', () => {
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(200)
    expect(decodeFrame(blank, 64, 64)).toBeNull()
  })

  it('decodePairing segue devolvendo só o pareamento (QR estrangeiro vira null)', () => {
    const site = qrFrame('https://example.com/qualquer')
    expect(decodePairing(site.data, site.size, site.size)).toBeNull()
  })
})
