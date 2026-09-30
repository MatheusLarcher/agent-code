// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeForWhisper, UnsupportedAudioError, WHISPER_SAMPLE_RATE } from './audioDecode'
import { encodeWavPcm16 } from './pcm'
import { dominantHz, sine } from './testSignals'

// 1 s of a 440 Hz tone encoded by ffmpeg/libopus (mono WebM, stereo Ogg).
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)))

describe('decodeForWhisper', () => {
  it('decodes WebM/Opus (phone MediaRecorder) to 16 kHz mono with the right pitch', async () => {
    const pcm = await decodeForWhisper(fixture('tone440-mono.webm'), 'audio/webm;codecs=opus')
    expect(Math.abs(pcm.length - WHISPER_SAMPLE_RATE)).toBeLessThan(800) // 1 s ± 50 ms of codec padding
    expect(dominantHz(pcm, WHISPER_SAMPLE_RATE)).toBeCloseTo(440, -1)
  })

  it('decodes stereo Ogg/Opus, mixing down to mono', async () => {
    const pcm = await decodeForWhisper(fixture('tone440-stereo.ogg'), 'audio/ogg')
    expect(Math.abs(pcm.length - WHISPER_SAMPLE_RATE)).toBeLessThan(800)
    expect(dominantHz(pcm, WHISPER_SAMPLE_RATE)).toBeCloseTo(440, -1)
  })

  it('trusts the bytes, not the MIME type', async () => {
    const pcm = await decodeForWhisper(fixture('tone440-stereo.ogg'), 'audio/webm')
    expect(pcm.length).toBeGreaterThan(15000)
  })

  it('resamples a 24 kHz WAV (Kokoro output) to 16 kHz', async () => {
    const x = sine(440, 24000, 1)
    const pcm = await decodeForWhisper(new Uint8Array(encodeWavPcm16(x, 24000)), 'audio/wav')
    expect(pcm.length).toBe(16000)
    expect(dominantHz(pcm, 16000)).toBeCloseTo(440, -1)
  })

  it('flags formats without a local decoder so the host can fall back to Chromium', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...'ftypmp42'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0])
    await expect(decodeForWhisper(mp4, 'audio/mp4')).rejects.toBeInstanceOf(UnsupportedAudioError)
    await expect(decodeForWhisper(mp4, 'audio/mp4')).rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO' })
  })
})
