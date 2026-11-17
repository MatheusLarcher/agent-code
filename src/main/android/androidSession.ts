import { AndroidDevice } from './androidDevice'
import type { Progress } from './androidEnv'

/**
 * O aparelho Android ativo de UMA conversa (emulador em janela no PC, ou o
 * celular ligado por USB). As ferramentas android_* falam com ele; nada aqui
 * desenha tela dentro do app.
 */
export class AndroidSession {
  private current: AndroidDevice | null = null
  private opening: Promise<AndroidDevice> | null = null

  /** O aparelho já ligado desta conversa, ou null. */
  get device(): AndroidDevice | null {
    return this.current
  }

  /** Liga o aparelho (uma vez) e devolve-o; chamadas simultâneas esperam a mesma partida. */
  open(progress?: Progress): Promise<AndroidDevice> {
    if (this.current) return Promise.resolve(this.current)
    this.opening ??= bootSerialized(progress)
      .then((device) => (this.current = device))
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }

  /** Desliga o emulador que esta conversa ligou (um celular USB só volta à resolução dele). */
  async close(): Promise<void> {
    const device = this.current ?? (await this.opening?.catch(() => null)) ?? null
    this.current = null
    await device?.stop().catch(() => undefined)
  }
}

/** Fila única de partida: duas conversas pedindo o emulador ao mesmo tempo não
 *  sobem dois — a segunda encontra o da primeira já no adb e usa o mesmo. */
let bootQueue: Promise<unknown> = Promise.resolve()

function bootSerialized(progress: Progress = () => undefined): Promise<AndroidDevice> {
  const boot = bootQueue.then(async () => {
    const device = new AndroidDevice()
    await device.ensureBooted(progress) // lança se a toolchain não está instalada
    return device
  })
  bootQueue = boot.catch(() => undefined)
  return boot
}

const sessions = new Map<string, AndroidSession>()

/** A sessão Android da conversa (criada sob demanda). */
export function androidSessionFor(convId: string): AndroidSession {
  let s = sessions.get(convId)
  if (!s) {
    s = new AndroidSession()
    sessions.set(convId, s)
  }
  return s
}

export async function disposeAndroidSession(convId: string): Promise<void> {
  const s = sessions.get(convId)
  if (!s) return
  sessions.delete(convId)
  await s.close()
}

export async function disposeAllAndroidSessions(): Promise<void> {
  const open = [...sessions.values()]
  sessions.clear()
  await Promise.all(open.map((s) => s.close()))
}
