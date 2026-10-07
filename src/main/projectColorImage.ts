/**
 * Decodificador do logo para o detector de cor (projectColorScan.ts) com o
 * `nativeImage` do Electron — sem dependência nova. Pela documentação
 * (https://www.electronjs.org/docs/latest/api/native-image): PNG e JPEG em
 * todas as plataformas, ICO só no Windows e pelo CAMINHO. WebP e o resto: null.
 */
import { nativeImage } from 'electron'
import type { Pixels } from './projectColor'
import type { DecodeImage } from './projectColorScan'

/** Lado da imagem reduzida: para a cor dominante, 32 px bastam. */
const SAMPLE_SIZE = 32

/**
 * `toBitmap()` devolve BGRA com alfa PRÉ-multiplicado (o formato nativo do Skia
 * no Chromium) → RGBA com alfa direto, que o histograma lê.
 */
export function bgraPremultipliedToRgba(bitmap: Uint8Array): Uint8Array {
  const out = new Uint8Array(bitmap.length)
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const a = bitmap[i + 3]
    const k = a > 0 ? 255 / a : 0
    out[i] = Math.min(255, Math.round(bitmap[i + 2] * k))
    out[i + 1] = Math.min(255, Math.round(bitmap[i + 1] * k))
    out[i + 2] = Math.min(255, Math.round(bitmap[i] * k))
    out[i + 3] = a
  }
  return out
}

export const decodeWithNativeImage: DecodeImage = async ({ file, mime, bytes }) => {
  let image: Electron.NativeImage
  if (mime === 'image/png' || mime === 'image/jpeg') image = nativeImage.createFromBuffer(bytes)
  else if (mime === 'image/x-icon' && process.platform === 'win32') image = nativeImage.createFromPath(file)
  else return null
  if (image.isEmpty()) return null
  const small = image.resize({ width: SAMPLE_SIZE, height: SAMPLE_SIZE, quality: 'good' })
  const { width, height } = small.getSize()
  const data = bgraPremultipliedToRgba(small.toBitmap())
  return width > 0 && height > 0 ? ({ width, height, data } satisfies Pixels) : null
}
