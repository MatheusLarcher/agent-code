import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parakeetInstalled } from './parakeetFiles'
import { KOKORO_MODEL } from './protocol'

export { parakeetInstalled }

/**
 * Whether Kokoro's weights are already in the model cache (the transformers
 * layout: `<cacheDir>/<repo>/onnx/<file>`), so the next read-aloud starts
 * without downloading. The cache gets the file after its download completes.
 */
export function kokoroInstalled(cacheDir: string): boolean {
  return existsSync(join(cacheDir, KOKORO_MODEL, 'onnx', 'model.onnx'))
}

/** Both: what the mic menu's "Instalar voz e transcrição" installs. */
export function voiceModelsInstalled(cacheDir: string): boolean {
  return kokoroInstalled(cacheDir) && parakeetInstalled(cacheDir)
}
