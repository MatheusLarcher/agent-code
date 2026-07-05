// Local voice-activity detection for mic dictation — no external model or library
// (offline, runs off the AudioContext analyser the composer already has). It lets
// the recorder segment speech at NATURAL PAUSES instead of fixed time blocks, so
// words are never cut mid-syllable, and the caller drops silence-only segments so
// pure silence is never sent to the transcription API (no hallucinated words over
// silence). Pure + framework-free so it can be unit-tested without a real mic.

/** Time-domain RMS above this (0..1) counts as voice. Tuned for a typical headset/
 *  laptop mic; quiet room noise sits below it. */
export const VAD_SPEECH_RMS = 0.02
/** Silence this long (ms) AFTER voice was heard ends the current utterance. ~0.8s
 *  is a natural sentence pause, short enough to feel responsive, long enough not to
 *  cut between words. */
export const VAD_SILENCE_HOLD_MS = 800
/** Safety cap (ms): finalize an utterance even without a pause, so a long monologue
 *  still gets transcribed in pieces instead of growing unbounded. */
export const VAD_MAX_SEG_MS = 30_000
/** Pre-roll rotation (ms): while NO speech has been detected yet, the recorder runs
 *  in short rolling segments this long, each discarded if it stays silent. When
 *  speech starts, the current roll already holds the milliseconds BEFORE the
 *  trigger frame — so the attack of the first word (soft consonants below the
 *  threshold) is preserved instead of clipped. Short enough that a discarded
 *  silent roll never carries meaningful audio. */
export const VAD_PREROLL_MS = 500

export interface VadState {
  /** Whether any voice was detected in the current segment — gates transcription. */
  hadSpeech: boolean
  /** Timestamp (ms) of the most recent frame that contained voice. */
  lastVoiceAt: number
  /** Timestamp (ms) the current segment started recording. */
  segStartAt: number
}

export function newVadState(now: number): VadState {
  return { hadSpeech: false, lastVoiceAt: now, segStartAt: now }
}

/** RMS (0..1) of one time-domain frame from `AnalyserNode.getByteTimeDomainData`
 *  (bytes centered at 128). 0 = silence, higher = louder. */
export function frameRms(time: Uint8Array): number {
  if (time.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128
    sumSq += v * v
  }
  return Math.sqrt(sumSq / time.length)
}

/** Advance the VAD by one analyser frame. Mutates and returns `state`; `end` is
 *  true when the current utterance should be finalized now — the caller then
 *  transcribes it if `state.hadSpeech`, or discards it (silence) if not. */
export function vadStep(state: VadState, rms: number, now: number): { state: VadState; end: boolean } {
  if (rms > VAD_SPEECH_RMS) {
    state.hadSpeech = true
    state.lastVoiceAt = now
  }
  const end =
    state.hadSpeech &&
    (now - state.lastVoiceAt > VAD_SILENCE_HOLD_MS || now - state.segStartAt > VAD_MAX_SEG_MS)
  return { state, end }
}

/** Whether a still-silent segment should be discarded and restarted (pre-roll
 *  rotation). Only applies before any speech: once `hadSpeech` is true the
 *  segment must end via `vadStep` (natural pause / max cap), never rotated —
 *  rotation mid-speech would cut a word in half. */
export function shouldRotatePreroll(state: VadState, now: number): boolean {
  return !state.hadSpeech && now - state.segStartAt > VAD_PREROLL_MS
}

/** "Armed" (listening, not recording) → recording transition. Call this once
 *  per frame while no segment is active — i.e. during silence, or in the gap
 *  between two utterances. Returns `null` while the frame is still silence
 *  (stay armed; nothing to record — this is how leading silence is removed:
 *  it's simply never captured, nothing to trim after the fact). The instant a
 *  frame crosses the speech threshold, returns a fresh `VadState` with
 *  `hadSpeech` already true (that trigger frame IS speech) — the caller should
 *  start recording at that exact moment, so the very first voiced sample is
 *  the first byte of audio sent to the API. */
export function tryArmedTrigger(rms: number, now: number): VadState | null {
  if (rms <= VAD_SPEECH_RMS) return null
  const state = newVadState(now)
  state.hadSpeech = true
  return state
}
