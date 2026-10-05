// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { voiceModelsInstalled } from './installed'
import { PARAKEET_FILES, PARAKEET_MODEL } from './protocol'

const dirs: string[] = []
/** Files of the given sizes (extended with truncate: the ~650 MB encoder costs no write). */
function cache(files: Array<[string, number]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-installed-'))
  dirs.push(dir)
  for (const [f, size] of files) {
    const p = join(dir, f)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '')
    truncateSync(p, size)
  }
  return dir
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const KOKORO: [string, number] = ['onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx', 0]
const parakeet = (sizes: Partial<Record<string, number>> = {}): Array<[string, number]> =>
  Object.values(PARAKEET_FILES)
    .filter((f) => sizes[f.name] !== -1)
    .map((f) => [`${PARAKEET_MODEL}/${f.name}`, sizes[f.name] ?? f.size])

describe('voiceModelsInstalled', () => {
  it('cache vazio ou só com o Kokoro: não instalado', () => {
    expect(voiceModelsInstalled(cache([]))).toBe(false)
    expect(voiceModelsInstalled(cache([KOKORO]))).toBe(false)
  })

  it('Kokoro + todos os arquivos do Parakeet no tamanho certo: instalado', () => {
    expect(voiceModelsInstalled(cache([KOKORO, ...parakeet()]))).toBe(true)
  })

  it('arquivo faltando ou com tamanho errado (download interrompido): não instalado', () => {
    expect(voiceModelsInstalled(cache([KOKORO, ...parakeet({ [PARAKEET_FILES.encoder.name]: 10 })]))).toBe(false)
    expect(voiceModelsInstalled(cache([KOKORO, ...parakeet({ [PARAKEET_FILES.vocab.name]: -1 })]))).toBe(false)
  })
})
