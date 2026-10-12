/**
 * O Quadro e o Scrum Master no celular (shared/remoteIpc.ts): a ponte chama os
 * MESMOS listeners que o `ipcMain` atende para a tela do PC — só os canais de
 * REMOTE_IPC_INVOKE. Quem registra um handler passa por `handle`, que grava no
 * `ipcMain` (o PC segue igual) e, se o canal está na lista, também aqui.
 *
 * Nenhum listener destes canais lê o evento do IPC (e.sender etc.): o celular
 * chega com um evento falso, marcado `remote: true`.
 */
import {
  REMOTE_IPC_EVENT_KIND,
  isRemoteIpcChannel,
  parseRemoteIpcRequest,
  type RemoteIpcChannel,
  type RemoteIpcEvent,
  type RemoteIpcEventChannel,
  type RemoteIpcRequest,
  type RemoteIpcResponse
} from '../../shared/remoteIpc'
import { OFFICE_BRIDGE_CONV } from '../../shared/officeCall'

/** A mesma assinatura do listener do `ipcMain.handle` (args `any[]`, como no Electron). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppIpcListener = (event: unknown, ...args: any[]) => unknown

/** O evento falso que o listener recebe quando a chamada vem do celular. */
export const REMOTE_IPC_FAKE_EVENT = Object.freeze({ remote: true as const })

export class AppIpcBridge {
  private readonly listeners = new Map<RemoteIpcChannel, AppIpcListener>()

  /** `register`: o registro de verdade (ipcMain.handle). `wrap`: o que o ipcMain
   *  põe em volta do listener (a faixa interativa de leitura), para o celular ter o mesmo. */
  constructor(
    private readonly register: (channel: string, listener: AppIpcListener) => void,
    private readonly wrap: (channel: string, listener: AppIpcListener) => AppIpcListener = (_c, l) => l
  ) {}

  /** Registra no ipcMain e, se o canal é da lista do celular, no registro da ponte. */
  handle(channel: string, listener: AppIpcListener): void {
    this.register(channel, listener)
    if (isRemoteIpcChannel(channel)) this.listeners.set(channel, this.wrap(channel, listener))
  }

  has(channel: string): boolean {
    return isRemoteIpcChannel(channel) && this.listeners.has(channel)
  }

  channels(): RemoteIpcChannel[] {
    return [...this.listeners.keys()]
  }

  /** `null` = canal fora da lista ou sem handler registrado; o erro do listener propaga. */
  async invoke(channel: string, args: readonly unknown[]): Promise<{ result: unknown } | null> {
    if (!isRemoteIpcChannel(channel)) return null
    const listener = this.listeners.get(channel)
    if (!listener) return null
    return { result: await listener(REMOTE_IPC_FAKE_EVENT, ...args) }
  }
}

export interface AppIpcHttpAnswer {
  status: number
  body: RemoteIpcResponse
}

/**
 * O POST /api/ipc inteiro, sem o HTTP: `body` é o texto do corpo (null = grande
 * demais). 400 inválido, 404 sem handler, 500 erro do handler, 200 com o resultado.
 */
export async function answerAppIpc(
  body: string | null,
  invoke: (channel: RemoteIpcRequest['channel'], args: unknown[]) => Promise<{ result: unknown } | null>
): Promise<AppIpcHttpAnswer> {
  if (body === null) return { status: 413, body: { ok: false, error: 'corpo grande demais' } }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: 400, body: { ok: false, error: 'JSON inválido' } }
  }
  const req = parseRemoteIpcRequest(parsed)
  if (!req) return { status: 400, body: { ok: false, error: 'pedido inválido (canal fora da lista ou args)' } }
  try {
    const out = await invoke(req.channel, req.args)
    if (!out) return { status: 404, body: { ok: false, error: `canal sem handler: ${req.channel}` } }
    return { status: 200, body: { ok: true, result: out.result ?? null } }
  } catch (err) {
    return { status: 500, body: { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }
}

/** A linha SSE de um aviso do main ao celular, no envelope do escritório. */
export function appIpcEventLine(channel: RemoteIpcEventChannel, payload: unknown): string {
  const event: RemoteIpcEvent = { kind: REMOTE_IPC_EVENT_KIND, channel, payload }
  return `data: ${JSON.stringify({ convId: OFFICE_BRIDGE_CONV, event })}\n\n`
}
