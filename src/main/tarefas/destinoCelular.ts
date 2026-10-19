import { Channels } from '../../shared/ipc'
import type { PushRequest, PushResult } from '../remote/relayClient'
import { validPushToken } from '../remote/remotePairing'
import { curto, type DestinoAviso, type EntregaDeps } from './entrega'
import type { AvisoTarefa } from './regras'

/**
 * Para onde vai o aviso (card decisao-aviso-vai-ao-pc-se-estiver-em-uso-senao-ao-celul):
 * PC em uso (mexeu há menos de 5 min E tela desbloqueada) → só o Windows; senão →
 * push no celular pelo broker. Sem celular registrado → Windows (e registra no log).
 * Broker fora ou erro do FCM → `false`, e a entrega (entrega.ts) cai no Windows.
 */

/** Mexeu no PC há menos que isto = está usando. */
export const PC_EM_USO_SEG = 300

export interface DestinoDeps {
  ociosoSegundos(): number
  telaBloqueada(): boolean
  /** O token FCM do celular pareado, ou null. */
  tokenCelular(): string | null
  log?(line: string): void
}

export function pcEmUso(ociosoSegundos: number, telaBloqueada: boolean): boolean {
  return !telaBloqueada && ociosoSegundos < PC_EM_USO_SEG
}

export function criarDestino(deps: DestinoDeps): (aviso: AvisoTarefa) => DestinoAviso {
  return (aviso) => {
    if (pcEmUso(deps.ociosoSegundos(), deps.telaBloqueada())) return 'windows'
    if (!deps.tokenCelular()) {
      deps.log?.(`[avisos] PC parado, mas nenhum celular registrado para push: "${aviso.titulo}" vai ao Windows`)
      return 'windows'
    }
    return 'celular'
  }
}

export interface EnvioCelularDeps {
  tokenCelular(): string | null
  push(req: PushRequest): Promise<PushResult>
  log?(line: string): void
}

/** Monta o push (título + frase curta; o toque abre a conversa) e diz se chegou ao FCM. */
export function criarEnvioCelular(deps: EnvioCelularDeps): (aviso: AvisoTarefa) => Promise<boolean> {
  return async (aviso) => {
    const token = deps.tokenCelular()
    if (!token) return false
    const r = await deps.push({
      token,
      title: curto(aviso.titulo, 64),
      body: curto(aviso.texto, 180),
      data: { convId: aviso.convId, ...(aviso.tarefaId ? { tarefaId: aviso.tarefaId } : {}) }
    })
    if (!r.ok) deps.log?.(`[avisos] push recusado (${r.status}${r.error ? ` ${r.error}` : ''})`)
    return r.ok
  }
}

export interface AvisoCelularDeps {
  pairing: { pushToken(): string | null; setPushToken(token: string | null): boolean }
  push(req: PushRequest): Promise<PushResult>
  powerMonitor: { getSystemIdleTime(): number; on(event: 'lock-screen' | 'unlock-screen', fn: () => void): unknown }
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void
  log?(line: string): void
}

/** A ligação no app (index.ts): o canal do token e o destino/envio para setupTarefasApp. */
export function ligarAvisoCelular(deps: AvisoCelularDeps): Pick<EntregaDeps, 'destino' | 'celular'> {
  const telaBloqueada = rastrearBloqueio(deps.powerMonitor)
  const tokenCelular = (): string | null => deps.pairing.pushToken()
  deps.handle(Channels.celularPushToken, (_event, raw) => {
    const dado = (raw ?? {}) as { token?: unknown }
    const token = dado.token === null ? null : validPushToken(dado.token)
    if (dado.token !== null && !token) return { ok: false, erro: 'token inválido' }
    const ok = deps.pairing.setPushToken(token)
    return ok ? { ok: true } : { ok: false, erro: 'nenhum celular pareado' }
  })
  return {
    destino: criarDestino({ ociosoSegundos: () => deps.powerMonitor.getSystemIdleTime(), telaBloqueada, tokenCelular, log: deps.log }),
    celular: criarEnvioCelular({ tokenCelular, push: deps.push, log: deps.log })
  }
}

/** Acompanha o bloqueio da tela pelo powerMonitor (o Electron não tem "está bloqueada?"). */
export function rastrearBloqueio(pm: { on(event: 'lock-screen' | 'unlock-screen', fn: () => void): unknown }): () => boolean {
  let bloqueada = false
  pm.on('lock-screen', () => {
    bloqueada = true
  })
  pm.on('unlock-screen', () => {
    bloqueada = false
  })
  return () => bloqueada
}
