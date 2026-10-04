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
const has = (cacheDir: string, repo: string, file: string): boolean => existsSync(join(cacheDir, repo, 'onnx', file))

/** Kokoro (read-aloud). */
export function kokoroInstalled(cacheDir: string): boolean {
  return has(cacheDir, KOKORO_MODEL, 'model.onnx')
}

/** One Whisper profile, in the precision this machine will load (GPU encoder when there is one). */
export function whisperInstalled(cacheDir: string, profile: WhisperProfile): boolean {
  const spec: WhisperSpec = WHISPER_PROFILES[profile]
  const encoder = spec.gpuEncoder && gpuDeviceFor() ? spec.gpuEncoder : spec.dtype.encoder_model
  return (
    has(cacheDir, spec.model, `encoder_model${SUFFIX[encoder]}.onnx`) &&
    has(cacheDir, spec.model, `decoder_model_merged${SUFFIX[spec.dtype.decoder_model_merged]}.onnx`)
  )
}

/** Both: what the mic menu's "Instalar voz e transcrição" installs. */
export function voiceModelsInstalled(cacheDir: string, profile: WhisperProfile): boolean {
  return kokoroInstalled(cacheDir) && whisperInstalled(cacheDir, profile)
}
