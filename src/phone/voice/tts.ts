/**
 * "Ouvir" (e "Ler daqui"): a voz é sintetizada no PC (Kokoro local, voz e
 * velocidade dele — toca a 1×). O PC divide o texto em partes curtas; tocamos em
 * ordem enquanto a próxima é sintetizada, então o 1º áudio começa rápido e
 * respostas longas funcionam. Tocar de novo na mesma mensagem para.
 */
import { createClipPlayer } from '@renderer/ui/clipPlayer'
import { client, toast } from '../app/runtime'
import { HttpError } from '../core/net'
import { createStore } from '../core/store'

type TtsReply = { ok?: boolean; audioBase64?: string; mimeType?: string; error?: string; parts?: string[] }

export const tts = createStore<{ speakingId: string | null }>({ speakingId: null })
// Uma saída de áudio aberta durante a leitura toda (ui/clipPlayer.ts): um <audio>
// por parte cortava o começo de cada parte.
const player = createClipPlayer()

/** Resposta JSON mesmo quando a ponte devolve erro HTTP com corpo (503 voice-unavailable). */
async function postReply(path: string, body: unknown): Promise<TtsReply | null> {
  try {
    return await client.post<TtsReply>(path, body, 60000)
  } catch (err) {
    return err instanceof HttpError && err.body && typeof err.body === 'object' ? (err.body as TtsReply) : null
  }
}

export function stopSpeak(): void {
  tts.set({ speakingId: null })
  player.stop()
}

export function toggleSpeak(id: string, text: string): void {
  if (tts.get().speakingId === id) return stopSpeak()
  stopSpeak()
  tts.set({ speakingId: id })
  // Ainda dentro do toque: a WebView só libera o áudio a partir de um gesto.
  player.prime()
  const alive = (): boolean => tts.get().speakingId === id
  const fail = (d: TtsReply | null): void => {
    if (!alive()) return
    stopSpeak()
    toast('Falha ao gerar o áudio' + (d?.error ? `: ${d.error}` : '.'))
  }
  void postReply('/api/tts-parts', { text }).then((d) => {
    if (!alive()) return
    // PC antigo sem a rota de partes: pede o texto inteiro de uma vez.
    const treated = !!(d?.ok && d.parts)
    const parts = treated ? (d!.parts as string[]) : [text]
    if (!parts.length) return stopSpeak()
    const pending = new Map<number, Promise<TtsReply | null>>()
    const fetchPart = (i: number): Promise<TtsReply | null> | null => {
      if (i >= parts.length) return null
      if (!pending.has(i)) pending.set(i, postReply('/api/tts', { text: parts[i], treated }))
      return pending.get(i)!
    }
    const playAt = (i: number): void => {
      if (!alive()) return
      if (i >= parts.length) return stopSpeak()
      const p = fetchPart(i)!
      fetchPart(i + 1)
      void p.then((r) => {
        if (!alive()) return // cancelado enquanto carregava
        if (!(r?.ok && r.audioBase64)) return fail(r)
        void player.play(r.audioBase64).then(() => {
          if (alive()) playAt(i + 1)
        })
      })
    }
    playAt(0)
  })
}
