/**
 * Turn whatever the recorder sent into what Whisper wants: 16 kHz mono float.
 *
 * - WAV (desktop recorder): parsed here, mixed down, resampled.
 * - WebM/Opus and Ogg/Opus (phone MediaRecorder): demuxed by containers.ts and
 *   decoded by libopus (opus-decoder, MIT, WASM inlined in JS — no native
 *   binary, no ffmpeg). libopus decodes straight to 16 kHz, so no resampling.
 * - Anything else (mp4/AAC from Safari, mp3…) throws UnsupportedAudioError;
 *   inside Electron the host retries through Chromium's own decoder
 *   (chromiumDecode.ts), which ships AAC/MP3 with Electron's ffmpeg.
 *
 * Detection is by magic bytes, not by the MIME string — phones lie about it
 * (`audio/webm` for an Ogg file and vice versa).
 */
import { OpusDecoder } from 'opus-decoder'
import { demuxOggOpus, demuxWebm, isOgg, isWebm, parseOpusHead, type DemuxedAudio } from './containers'
import { isWav, mixToMono, parseWav, resample } from './pcm'

export const WHISPER_SAMPLE_RATE = 16000

export class UnsupportedAudioError extends Error {
  readonly code = 'UNSUPPORTED_AUDIO'
}

export async function decodeForWhisper(bytes: Uint8Array, mimeType: string): Promise<Float32Array> {
  if (isWav(bytes)) {
    const { channels, sampleRate } = parseWav(bytes)
    return resample(mixToMono(channels), sampleRate, WHISPER_SAMPLE_RATE)
  }
  if (isWebm(bytes)) {
    const demuxed = demuxWebm(bytes)
    if (demuxed.codec !== 'A_OPUS') throw new UnsupportedAudioError(`WebM com codec ${demuxed.codec || 'desconhecido'}`)
    return decodeOpus(demuxed)
  }
  if (isOgg(bytes)) return decodeOpus(demuxOggOpus(bytes))
  throw new UnsupportedAudioError(`formato de áudio sem decodificador local (${mimeType || 'desconhecido'})`)
}

async function decodeOpus(d: DemuxedAudio): Promise<Float32Array> {
  const head = d.codecPrivate ? parseOpusHead(d.codecPrivate) : { channels: 1, preSkip: 0, mappingFamily: 0 }
  if (head.mappingFamily !== 0 || head.channels < 1 || head.channels > 2) {
    throw new UnsupportedAudioError(`Opus com ${head.channels} canais (família ${head.mappingFamily})`)
  }
  if (d.packets.length === 0) return new Float32Array(0)
  const decoder = new OpusDecoder({ channels: head.channels, sampleRate: WHISPER_SAMPLE_RATE })
  await decoder.ready
  try {
    const out = decoder.decodeFrames(d.packets)
    const mono = mixToMono(out.channelData.map((c) => c.subarray(0, out.samplesDecoded)))
    // pre-skip is counted at 48 kHz (RFC 7845); we decode at 16 kHz.
    const skip = Math.round((head.preSkip * WHISPER_SAMPLE_RATE) / 48000)
    return mono.slice(Math.min(skip, mono.length))
  } finally {
    decoder.free()
  }
}
