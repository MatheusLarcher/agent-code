// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import { criarDestino, criarEnvioCelular, ligarAvisoCelular, pcEmUso } from './destinoCelular'
import { EntregaAvisos, type NotificacaoLike } from './entrega'
import type { AvisoTarefa } from './regras'

/** Para onde vai o aviso (PC em uso → Windows, senão celular) e a queda no Windows quando o push falha. */

const TOKEN = 'fcm-token-do-celular-0123456789abcdef:APA91b'
const aviso: AvisoTarefa = { tipo: 'lembrete', convId: 'c1', tarefaId: 't1', titulo: 'Beber água', texto: 'Hora da água.' }

function pcFalso() {
  const ouvintes = new Map<string, () => void>()
  let ocioso = 0
  return {
    pm: { getSystemIdleTime: () => ocioso, on: (ev: 'lock-screen' | 'unlock-screen', fn: () => void) => ouvintes.set(ev, fn) },
    ocioso: (s: number) => (ocioso = s),
    emitir: (ev: string) => ouvintes.get(ev)?.()
  }
}

function pairingFalso(token: string | null, pareado = true) {
  let atual = token
  return {
    pushToken: () => (pareado ? atual : null),
    setPushToken: (t: string | null) => (pareado ? ((atual = t), true) : false)
  }
}

function montar(over: { token?: string | null; push?: () => Promise<{ ok: boolean; status: number; error?: string }> } = {}) {
  const pc = pcFalso()
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const push = vi.fn(over.push ?? (async () => ({ ok: true, status: 200 })))
  const log = vi.fn()
  const pairing = pairingFalso(over.token === undefined ? TOKEN : over.token)
  const ligado = ligarAvisoCelular({ pairing, push, powerMonitor: pc.pm, handle: (c, fn) => handlers.set(c, fn), log })
  const criadas: string[] = []
  const entrega = new EntregaAvisos({
    suportado: () => true,
    criar: (o) => (criadas.push(o.title), { on: () => undefined, show: () => undefined } as NotificacaoLike),
    abrir: () => undefined,
    log,
    ...ligado
  })
  return { pc, push, log, entrega, criadas, handlers, pairing }
}

const espera = () => new Promise((r) => setTimeout(r, 0))

describe('destino do aviso', () => {
  it('PC em uso (mexeu há < 5 min, tela livre) → só Windows, sem push', async () => {
    const m = montar()
    m.pc.ocioso(120)
    m.entrega.entregar(aviso)
    await espera()
    expect(m.criadas).toEqual(['Beber água'])
    expect(m.push).not.toHaveBeenCalled()
  })

  it('parado há 5 min ou mais → push no celular com título, frase e a conversa', async () => {
    const m = montar()
    m.pc.ocioso(300)
    m.entrega.entregar(aviso)
    await espera()
    expect(m.criadas).toEqual([])
    expect(m.push).toHaveBeenCalledWith({ token: TOKEN, title: 'Beber água', body: 'Hora da água.', data: { convId: 'c1', tarefaId: 't1' } })
  })

  it('tela bloqueada, mesmo mexendo agora → celular; ao desbloquear volta ao Windows', async () => {
    const m = montar()
    m.pc.ocioso(5)
    m.pc.emitir('lock-screen')
    m.entrega.entregar(aviso)
    await espera()
    expect(m.push).toHaveBeenCalledTimes(1)
    m.pc.emitir('unlock-screen')
    m.entrega.entregar(aviso)
    await espera()
    expect(m.criadas).toEqual(['Beber água'])
    expect(m.push).toHaveBeenCalledTimes(1)
  })

  it('sem token do celular → Windows e registra no log', async () => {
    const m = montar({ token: null })
    m.pc.ocioso(900)
    m.entrega.entregar(aviso)
    await espera()
    expect(m.criadas).toEqual(['Beber água'])
    expect(m.push).not.toHaveBeenCalled()
    expect(m.log).toHaveBeenCalledWith(expect.stringContaining('nenhum celular registrado'))
  })

  it('broker fora ou erro do FCM → cai no Windows e registra', async () => {
    const fora = montar({ push: async () => ({ ok: false, status: 0, error: 'broker-desconectado' }) })
    fora.pc.ocioso(900)
    fora.entrega.entregar(aviso)
    await espera()
    expect(fora.criadas).toEqual(['Beber água'])
    expect(fora.log).toHaveBeenCalledWith(expect.stringContaining('push recusado (0 broker-desconectado)'))
    const fcm = montar({ push: async () => ({ ok: false, status: 404, error: 'UNREGISTERED' }) })
    fcm.pc.ocioso(900)
    fcm.entrega.entregar(aviso)
    await espera()
    expect(fcm.criadas).toEqual(['Beber água'])
    const lancou = montar({ push: async () => { throw new Error('boom') } })
    lancou.pc.ocioso(900)
    lancou.entrega.entregar(aviso)
    await espera()
    expect(lancou.criadas).toEqual(['Beber água'])
  })

  it('o canal do token: grava o válido, aceita null (limpa), recusa lixo e celular não pareado', () => {
    const m = montar({ token: null })
    const h = m.handlers.get(Channels.celularPushToken)!
    expect(h({}, { token: TOKEN })).toEqual({ ok: true })
    expect(m.pairing.pushToken()).toBe(TOKEN)
    expect(h({}, { token: '<script>' })).toEqual({ ok: false, erro: 'token inválido' })
    expect(h({}, { token: null })).toEqual({ ok: true })
    expect(m.pairing.pushToken()).toBeNull()
    const semPar = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    ligarAvisoCelular({ pairing: pairingFalso(null, false), push: vi.fn(), powerMonitor: pcFalso().pm, handle: (c, fn) => semPar.set(c, fn) })
    expect(semPar.get(Channels.celularPushToken)!({}, { token: TOKEN })).toEqual({ ok: false, erro: 'nenhum celular pareado' })
  })

  it('peças soltas: pcEmUso, criarDestino e criarEnvioCelular sem token', async () => {
    expect(pcEmUso(299, false)).toBe(true)
    expect(pcEmUso(300, false)).toBe(false)
    expect(pcEmUso(0, true)).toBe(false)
    expect(criarDestino({ ociosoSegundos: () => 999, telaBloqueada: () => false, tokenCelular: () => TOKEN })(aviso)).toBe('celular')
    expect(await criarEnvioCelular({ tokenCelular: () => null, push: vi.fn() })(aviso)).toBe(false)
  })
})
