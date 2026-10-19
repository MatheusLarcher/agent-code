/**
 * Aviso no celular com o app FECHADO: push do Firebase (FCM) que o broker da VPS
 * envia quando o PC não está em uso (main/tarefas/destinoCelular.ts).
 *
 * Pelo plugin @capacitor/push-notifications, falando com a ponte nativa que o
 * Android injeta (window.Capacitor), sem @capacitor/core no bundle — como o
 * ditado (voice/localStt.ts). A cada conexão com o PC (abrir o app, parear) pede a
 * permissão (Android 13+), registra e manda o token ao PC pelo POST /api/ipc.
 * Tocar no aviso abre a conversa de origem; com o app aberto, vira um aviso curto.
 */
import { Channels } from '@shared/ipc'
import { invokeIpc } from '../office/bridgeApi'
import { client, openConversation, quandoConectar, toast } from './runtime'

const PLUGIN = 'PushNotifications'
const CANAL = 'avisos'

type Dados = { convId?: unknown }
type Recebido = { title?: string; body?: string; data?: Dados }

let ligado = false
let ultimoToken: string | null = null
/** Toque no aviso antes de conectar ao PC: abre quando conectar. */
let conversaPendente: string | null = null
let avisouRecusa = false

/** Dentro do APK com o plugin compilado. */
export function pushDisponivel(): boolean {
  const cap = window.Capacitor
  if (!cap || typeof cap.nativePromise !== 'function' || typeof cap.addListener !== 'function') return false
  return (cap.PluginHeaders ?? []).some((h) => h?.name === PLUGIN)
}

function call<T>(method: string, opts: Record<string, unknown> = {}): Promise<T> {
  return window.Capacitor!.nativePromise!(PLUGIN, method, opts) as Promise<T>
}

function convDe(data: Dados | undefined): string | null {
  return data && typeof data.convId === 'string' && data.convId ? data.convId : null
}

function abrir(convId: string): void {
  if (client.state.screen === 'main') openConversation(convId)
  else conversaPendente = convId
}

async function enviarToken(token: string): Promise<void> {
  ultimoToken = token
  try {
    await invokeIpc(client, Channels.celularPushToken, [{ token }])
  } catch {
    /* o PC antigo não conhece o canal, ou caiu: tenta de novo na próxima conexão */
  }
}

/** A cada conexão: permissão, canal e registro (o token chega pelo evento `registration`). */
async function registrar(): Promise<void> {
  if (conversaPendente) {
    const id = conversaPendente
    conversaPendente = null
    openConversation(id)
  }
  try {
    let perm = await call<{ receive?: string }>('checkPermissions')
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await call('requestPermissions')
    if (perm.receive !== 'granted') {
      if (!avisouRecusa) {
        avisouRecusa = true
        toast('Notificações desligadas: os avisos não chegam com o app fechado. Ative em Configurações do Android › Apps › Agent Remote.', 'erro', 8000)
      }
      return
    }
    await call('createChannel', { id: CANAL, name: 'Avisos', description: 'Lembretes e monitores das tarefas', importance: 4, visibility: 1 }).catch(() => undefined)
    await call('register')
    if (ultimoToken) void enviarToken(ultimoToken) // o mesmo token, para o PC que acabou de conectar
  } catch {
    /* plugin indisponível nesta versão do APK: segue sem push */
  }
}

/** Liga uma vez, no início do app (main.tsx). Fora do APK não faz nada. */
export function ligarPush(): void {
  if (ligado || !pushDisponivel()) return
  ligado = true
  const cap = window.Capacitor!
  cap.addListener!(PLUGIN, 'registration', (data) => {
    const token = (data as { value?: unknown })?.value
    if (typeof token === 'string' && token) void enviarToken(token)
  })
  // O toque no aviso (com o app fechado, o plugin guarda o evento até este ouvinte existir).
  cap.addListener!(PLUGIN, 'pushNotificationActionPerformed', (data) => {
    const id = convDe((data as { notification?: Recebido })?.notification?.data)
    if (id) abrir(id)
  })
  // App aberto: o Android não mostra o aviso do FCM; mostra-se aqui.
  cap.addListener!(PLUGIN, 'pushNotificationReceived', (data) => {
    const n = (data ?? {}) as Recebido
    if (n.title) toast(n.body ? `${n.title} — ${n.body}` : n.title, 'sucesso', 6000)
  })
  quandoConectar(() => void registrar())
}
