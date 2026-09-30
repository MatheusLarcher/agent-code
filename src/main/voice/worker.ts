/**
 * Voice worker entry (built to out/main/voiceWorker.js).
 *
 * Runs as an Electron utilityProcess inside the app (own process: a native
 * crash in onnxruntime cannot take the main process down, and stopping it
 * frees the models' memory) or as a worker_threads Worker under plain Node
 * (scripts, benchmarks). Requests are handled one at a time — two inferences
 * in parallel would only fight for the same CPU cores.
 */
import { decodeForWhisper, UnsupportedAudioError } from './audioDecode'
import { configureCache, KOKORO_SAMPLE_RATE, loadKokoro, loadWhisper, synthesize, transcribe } from './models'
import { loadEspeakPtBr } from './phonemize'
import { encodeWavPcm16 } from './pcm'
import type { SynthesisResult, VoiceProgress, WorkerRequest, WorkerResponse } from './protocol'

interface Port {
  post(msg: WorkerResponse): void
  onMessage(cb: (msg: WorkerRequest) => void): void
}

async function openPort(): Promise<Port> {
  const utility = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort
  if (utility) {
    return {
      post: (msg) => utility.postMessage(msg),
      onMessage: (cb) => utility.on('message', (e) => cb(e.data as WorkerRequest))
    }
  }
  const { parentPort } = await import('node:worker_threads')
  if (!parentPort) throw new Error('voiceWorker precisa rodar como utilityProcess ou worker_threads')
  return {
    post: (msg) => parentPort.postMessage(msg),
    onMessage: (cb) => parentPort.on('message', cb)
  }
}

let configured = false

async function handle(req: WorkerRequest, progress: (p: VoiceProgress) => void): Promise<unknown> {
  if (req.op === 'config') {
    configureCache(req.cacheDir)
    configured = true
    return true
  }
  if (!configured) throw new Error('pasta de cache dos modelos não configurada')
  switch (req.op) {
    case 'prepare':
      if (req.what === 'tts') await Promise.all([loadKokoro(progress), loadEspeakPtBr()])
      else await loadWhisper(req.profile, progress)
      return true
    case 'synthesize': {
      const { samples, chunks } = await synthesize(req.text, req.voice, req.speed, progress)
      const wav = encodeWavPcm16(samples, KOKORO_SAMPLE_RATE)
      const result: SynthesisResult = {
        base64: wav.toString('base64'),
        mimeType: 'audio/wav',
        durationSec: samples.length / KOKORO_SAMPLE_RATE,
        chunks
      }
      return result
    }
    case 'transcribe': {
      let pcm = req.pcm
      if (!pcm) {
        progress({ phase: 'decode' })
        pcm = await decodeForWhisper(req.audio ?? new Uint8Array(0), req.mimeType ?? '')
      }
      if (pcm.length < 1600) return '' // < 0.1 s: nothing to hear
      return transcribe(pcm, req.profile, progress)
    }
  }
}

void (async () => {
  const port = await openPort()
  let queue: Promise<unknown> = Promise.resolve()
  port.onMessage((req) => {
    const progress = (p: VoiceProgress): void => port.post({ id: req.id, type: 'progress', progress: p })
    // config jumps the queue: it only changes where FUTURE downloads go.
    const run = (): Promise<void> =>
      handle(req, progress).then(
        (result) => port.post({ id: req.id, type: 'result', result }),
        (err: unknown) =>
          port.post({
            id: req.id,
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            code: err instanceof UnsupportedAudioError ? err.code : undefined
          })
      )
    if (req.op === 'config') void run()
    else queue = queue.then(run)
  })
})()
