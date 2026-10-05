// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getSttStatus, LOCAL_VOICES, PARAKEET_MODEL, prepareVoiceModels, setVoiceCacheDir, synthesizeLocal, transcribeSpeech } from './index'

// Boundary validation only — everything here is rejected before a worker is
// spawned. The real engine is exercised by scripts/voice/e2e.mjs.
describe('voice engine API validation', () => {
  it('exposes the three pt-BR voices, pf_dora first (the default), and Parakeet v3 for dictation', () => {
    expect(LOCAL_VOICES).toEqual(['pf_dora', 'pm_alex', 'pm_santa'])
    expect(PARAKEET_MODEL).toBe('istupakov/parakeet-tdt-0.6b-v3-onnx')
    expect(getSttStatus()).toEqual({ device: null, label: null })
  })

  it('requires the cache folder before starting the worker', async () => {
    await expect(synthesizeLocal('olá')).rejects.toThrow(/setVoiceCacheDir/)
    expect(() => setVoiceCacheDir('  ')).toThrow(TypeError)
  })

  it('rejects bad synthesis input', async () => {
    await expect(synthesizeLocal('   ')).rejects.toThrow(TypeError)
    await expect(synthesizeLocal('oi', { voice: 'af_heart' })).rejects.toThrow(/voz desconhecida/)
    await expect(synthesizeLocal('oi', { speed: 3 })).rejects.toThrow(RangeError)
    await expect(synthesizeLocal('oi', { speed: Number.NaN })).rejects.toThrow(RangeError)
    await expect(synthesizeLocal('a'.repeat(20_001))).rejects.toThrow(RangeError)
  })

  it('rejects empty audio and unknown model kinds', async () => {
    await expect(transcribeSpeech('', 'audio/wav')).rejects.toThrow(TypeError)
    await expect(transcribeSpeech('data:audio/webm;base64,', 'audio/webm')).rejects.toThrow(TypeError)
    await expect(prepareVoiceModels('whisper' as never)).rejects.toThrow(RangeError)
  })
})
