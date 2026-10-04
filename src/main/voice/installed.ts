import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gpuDeviceFor, KOKORO_MODEL, WHISPER_PROFILES, type Dtype, type WhisperProfile, type WhisperSpec } from './protocol'

const SUFFIX: Record<Dtype, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' }

/**
 * Whether the files the engine loads first are already in the model cache (the
 * transformers layout: `<cacheDir>/<repo>/onnx/<file>`), so the next dictation
 * or read-aloud starts without downloading. Weights only; the cache gets each
 * file after its download completes.
 */
export function voiceModelsInstalled(cacheDir: string, profile: WhisperProfile): boolean {
  const has = (repo: string, file: string): boolean => existsSync(join(cacheDir, repo, 'onnx', file))
  if (!has(KOKORO_MODEL, 'model.onnx')) return false
  const spec: WhisperSpec = WHISPER_PROFILES[profile]
  const encoder = spec.gpuEncoder && gpuDeviceFor() ? spec.gpuEncoder : spec.dtype.encoder_model
  return (
    has(spec.model, `encoder_model${SUFFIX[encoder]}.onnx`) &&
    has(spec.model, `decoder_model_merged${SUFFIX[spec.dtype.decoder_model_merged]}.onnx`)
  )
}
