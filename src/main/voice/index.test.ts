// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LOCAL_VOICES, setVoiceCacheDir, setWhisperProfile, synthesizeLocal, transcribeWhisper, WHISPER_PROFILE, WHISPER_PROFILES } from './index'

// Boundary validation only — everything here is rejected before a worker is
// spawned. The real engine is exercised by scripts/voice/e2e.mjs.
describe('voice engine API validation', () => {
  it('exposes the three pt-BR voices, pf_dora first (the default)', () => {
    expect(LOCAL_VOICES).toEqual(['pf_dora', 'pm_alex', 'pm_santa'])
    expect(WHISPER_PROFILES[WHISPER_PROFILE]).toBeDefined()
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

  it('rejects empty audio and unknown Whisper profiles', async () => {
    await expect(transcribeWhisper('', 'audio/wav')).rejects.toThrow(TypeError)
    await expect(transcribeWhisper('data:audio/webm;base64,', 'audio/webm')).rejects.toThrow(TypeError)
    expect(() => setWhisperProfile('huge' as never)).toThrow(/perfil Whisper/)
  })
})
