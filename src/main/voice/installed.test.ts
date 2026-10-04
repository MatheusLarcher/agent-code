// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { voiceModelsInstalled } from './installed'

const dirs: string[] = []
function cache(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-installed-'))
  dirs.push(dir)
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  return dir
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const KOKORO = 'onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx'
const SMALL = 'onnx-community/whisper-small/onnx'

describe('voiceModelsInstalled', () => {
  it('cache vazio ou só com o Kokoro: não instalado', () => {
    expect(voiceModelsInstalled(cache([]), 'small-q8')).toBe(false)
    expect(voiceModelsInstalled(cache([KOKORO]), 'small-q8')).toBe(false)
  })

  it('Kokoro + encoder/decoder do perfil: instalado (small-q8 é só CPU)', () => {
    const dir = cache([KOKORO, `${SMALL}/encoder_model_quantized.onnx`, `${SMALL}/decoder_model_merged_quantized.onnx`])
    expect(voiceModelsInstalled(dir, 'small-q8')).toBe(true)
    expect(voiceModelsInstalled(dir, 'turbo-q8')).toBe(false)
  })
})
