// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Model weights are downloaded on first use (voice-models in the cache folder);
// the installer must never carry them.
describe('installer carries no voice model weights', () => {
  const yml = readFileSync(join(__dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8')

  it('excludes ONNX weights from the packaged files', () => {
    expect(yml).toMatch(/^\s*- '!\*\*\/\*\.onnx'$/m)
    expect(yml).toMatch(/^\s*- '!\*\*\/\*\.onnx_data'$/m)
  })

  it('ships no model cache folder as a resource', () => {
    expect(yml).not.toMatch(/voice-models|huggingface|\.cache/i)
  })
})
