// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_WHISPER_MODEL, WHISPER_MODEL_OPTIONS } from '../../shared/ipc'
import {
  getWhisperStatus,
  LOCAL_VOICES,
  setVoiceCacheDir,
  setWhisperProfile,
  synthesizeLocal,
  transcribeWhisper,
  WHISPER_PROFILE,
  WHISPER_PROFILES
} from './index'

// Boundary validation only — everything here is rejected before a worker is
// spawned. The real engine is exercised by scripts/voice/e2e.mjs.
describe('voice engine API validation', () => {
  it('exposes the three pt-BR voices, pf_dora first (the default)', () => {
    expect(LOCAL_VOICES).toEqual(['pf_dora', 'pm_alex', 'pm_santa'])
    expect(WHISPER_PROFILES[WHISPER_PROFILE]).toBeDefined()
  })

  it('defaults to turbo-q8, and every model offered in Settings is an engine profile', () => {
    expect(WHISPER_PROFILE).toBe('turbo-q8')
    expect(DEFAULT_WHISPER_MODEL).toBe(WHISPER_PROFILE)
    for (const m of WHISPER_MODEL_OPTIONS) expect(Object.keys(WHISPER_PROFILES)).toContain(m.id)
    expect(WHISPER_PROFILES['turbo-q8']).toMatchObject({ model: 'onnx-community/whisper-large-v3-turbo', gpuEncoder: 'fp16' })
    expect(WHISPER_PROFILES['turbo-q8'].dtype).toEqual({ encoder_model: 'q8', decoder_model_merged: 'q8' })
    expect(getWhisperStatus()).toEqual({ profile: 'turbo-q8', device: null, label: null })
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
