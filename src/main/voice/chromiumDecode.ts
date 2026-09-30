/**
 * Fallback decoder for formats with no local WASM decoder (mp4/AAC from iOS
 * Safari, mp3, …): Chromium's own Web Audio `decodeAudioData`, run in a
 * hidden, sandboxed window. Electron's bundled ffmpeg already carries AAC/MP3,
 * so this costs no extra dependency. Only available inside Electron's main
 * process — the WASM path in audioDecode.ts covers WAV/WebM/Ogg everywhere.
 */
const WHISPER_SAMPLE_RATE = 16000 // same as audioDecode.ts (not imported: keeps opus-decoder out of the main bundle)
const DECODE_TIMEOUT_MS = 60_000

export function canDecodeWithChromium(): boolean {
  return Boolean(process.versions.electron) && (process as { type?: string }).type === 'browser'
}

export async function decodeWithChromium(bytes: Uint8Array): Promise<Float32Array> {
  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'voice-decode', backgroundThrottling: false }
  })
  try {
    await win.loadURL('about:blank')
    const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
    // decodeAudioData resamples to the context's rate; the mixdown is done here
    // and the samples come back as base64 of the Float32 bytes (compact and
    // survives executeJavaScript's serialization intact).
    const script = `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const ctx = new OfflineAudioContext(1, 1, ${WHISPER_SAMPLE_RATE});
      const buf = await ctx.decodeAudioData(u8.buffer);
      const out = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
      }
      const bytes = new Uint8Array(out.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    })()`
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('decodificação pelo Chromium excedeu o tempo')), DECODE_TIMEOUT_MS)
    })
    try {
      const out = (await Promise.race([win.webContents.executeJavaScript(script, true), timeout])) as string
      const raw = Buffer.from(out, 'base64')
      return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    throw new Error(`áudio não decodificável: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
