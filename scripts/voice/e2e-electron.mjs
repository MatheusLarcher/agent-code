// Same engine, but inside a real Electron main process: the worker runs as a
// utilityProcess, and mp4/AAC (no WASM decoder) goes through the Chromium
// fallback. Also probes the main event loop during a synthesis.
//
//   npx electron-vite build
//   npx electron scripts/voice/e2e-electron.mjs [--cache <dir>] [--out <dir>] [--profile <p>]
//
// ffmpeg (on PATH) only builds the WebM/M4A fixtures from the engine's own WAV.
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, defaultCache, dirArg, fmt, loadEngine, wer, withLoopProbe } from './lib.mjs'

const TEXT = 'A reunião foi remarcada para quinta-feira às três da tarde, na sala de sempre.'
const log = (...a) => console.log('[electron-e2e]', ...a)

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** Record `wav` through Chromium's real MediaRecorder (the phone's WebView
 *  path): live WebM with unknown-size Segment/Cluster, as the phone sends it. */
async function recordWithMediaRecorder(wav) {
  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await win.loadURL('about:blank')
    return await win.webContents.executeJavaScript(`(async () => {
      const bin = atob(${JSON.stringify(wav.toString('base64'))});
      const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const ctx = new AudioContext();
      await ctx.resume();
      const buf = await ctx.decodeAudioData(u8.buffer);
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(250);
      src.onended = () => setTimeout(() => rec.stop(), 300);
      src.start();
      await done;
      const blob = new Blob(chunks, { type: rec.mimeType });
      const out = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return btoa(s);
    })()`, true)
  } finally {
    win.destroy()
  }
}
app.on('window-all-closed', () => undefined) // the hidden decode window must not quit the app

async function main() {
  await app.whenReady()
  const cache = dirArg('cache', defaultCache)
  const out = dirArg('out', join(defaultCache, '..', 'agent-code-voice-e2e'))
  const eng = await loadEngine()
  eng.setVoiceCacheDir(cache)
  if (arg('profile')) eng.setWhisperProfile(arg('profile'))
  const report = { electron: process.versions.electron, processType: process.type }

  await eng.prepareVoiceModels('tts')
  const probe = await withLoopProbe(() => eng.synthesizeLocal(TEXT, { voice: 'pm_alex', speed: 1 }))
  const wav = Buffer.from(probe.result.base64, 'base64')
  const wavFile = join(out, 'electron_pm_alex.wav')
  writeFileSync(wavFile, wav)
  report.synth = { audioSec: probe.result.durationSec, ticks: probe.ticks, maxLagMs: probe.maxLagMs, p99LagMs: probe.p99LagMs }
  log(`síntese em utilityProcess: ${fmt(probe.result.durationSec)} s de áudio; event loop do main: ${probe.ticks} ticks, lag máx ${fmt(probe.maxLagMs, 1)} ms, p99 ${fmt(probe.p99LagMs, 1)} ms`)

  await eng.prepareVoiceModels('stt')
  report.transcribe = {}
  const cases = [['wav', 'audio/wav', null]]
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    cases.push(['webm', 'audio/webm;codecs=opus', ['-c:a', 'libopus', '-b:a', '32k']])
    cases.push(['m4a', 'audio/mp4', ['-c:a', 'aac', '-b:a', '64k']])
  } catch {
    log('ffmpeg ausente: só WAV')
  }
  for (const [ext, mime, codec] of cases) {
    const file = ext === 'wav' ? wavFile : join(out, `electron_pm_alex.${ext}`)
    if (codec) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavFile, '-ac', '1', ...codec, file])
    const t0 = performance.now()
    const text = await eng.transcribeWhisper(readFileSync(file).toString('base64'), mime)
    const sec = (performance.now() - t0) / 1000
    report.transcribe[ext] = { seconds: sec, wer: wer(TEXT, text), text }
    log(`${ext} (${mime}): WER ${fmt(wer(TEXT, text) * 100, 1)}% em ${fmt(sec)} s → "${text}"`)
  }
  // The phone's actual format: Chromium MediaRecorder WebM/Opus (live, unknown sizes).
  const recB64 = await recordWithMediaRecorder(wav)
  writeFileSync(join(out, 'electron_mediarecorder.webm'), Buffer.from(recB64, 'base64'))
  const t0 = performance.now()
  const recText = await eng.transcribeWhisper(recB64, 'audio/webm;codecs=opus')
  report.transcribe.mediaRecorderWebm = { seconds: (performance.now() - t0) / 1000, wer: wer(TEXT, recText), text: recText, bytes: Buffer.from(recB64, 'base64').length }
  log(`MediaRecorder webm: WER ${fmt(wer(TEXT, recText) * 100, 1)}% → "${recText}"`)

  await eng.stopVoiceEngine()
  writeFileSync(join(out, 'e2e-electron-report.json'), JSON.stringify(report, null, 2))
  log(`relatório: ${join(out, 'e2e-electron-report.json')}`)
}

main()
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[electron-e2e] FALHOU:', err)
    app.exit(1)
  })
