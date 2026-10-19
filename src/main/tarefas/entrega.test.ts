// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { curto, EntregaAvisos, type NotificacaoLike } from './entrega'
import type { AvisoTarefa } from './regras'

/** A entrega dos avisos com uma `Notification` falsa (o Electron real não roda no vitest). */

class FakeNotification implements NotificacaoLike {
  static criadas: FakeNotification[] = []
  readonly handlers = new Map<string, () => void>()
  mostrada = false
  constructor(readonly opcoes: { title: string; body: string }) {
    FakeNotification.criadas.push(this)
  }
  on(event: 'click' | 'close' | 'failed', fn: () => void): this {
    this.handlers.set(event, fn)
    return this
  }
  show(): void {
    this.mostrada = true
  }
  emit(event: string): void {
    this.handlers.get(event)?.()
  }
}

const aviso = (over: Partial<AvisoTarefa> = {}): AvisoTarefa => ({ tipo: 'bateu', convId: 'c1', tarefaId: 't1', titulo: 'Passagem · bateu', texto: 'R$ 2.900 — Google Flights', ...over })

function entrega(over: Partial<ConstructorParameters<typeof EntregaAvisos>[0]> = {}) {
  FakeNotification.criadas = []
  const abrir = vi.fn()
  const log = vi.fn()
  const e = new EntregaAvisos({ suportado: () => true, criar: (o) => new FakeNotification(o), abrir, log, ...over })
  return { e, abrir, log }
}

describe('entrega dos avisos — Windows', () => {
  it('mostra título curto + frase; o clique abre a conversa de origem e solta a notificação', () => {
    const { e, abrir } = entrega()
    e.entregar(aviso())
    const [n] = FakeNotification.criadas
    expect(n.mostrada).toBe(true)
    expect(n.opcoes).toEqual({ title: 'Passagem · bateu', body: 'R$ 2.900 — Google Flights' })
    expect(e.pendentes()).toBe(1)
    n.emit('click')
    expect(abrir).toHaveBeenCalledWith('c1')
    expect(e.pendentes()).toBe(0)
  })

  it('"failed" e "close" soltam sem lançar; sem suporte, nada aparece', () => {
    const { e, log } = entrega()
    e.entregar(aviso())
    expect(() => FakeNotification.criadas[0].emit('failed')).not.toThrow()
    expect(e.pendentes()).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recusou'))
    const sem = entrega({ suportado: () => false })
    sem.e.entregar(aviso())
    expect(FakeNotification.criadas).toHaveLength(0)
  })

  it('criar ou abrir que lança não derruba quem avisou', () => {
    const { e } = entrega({ criar: () => { throw new Error('boom') } })
    expect(() => e.entregar(aviso())).not.toThrow()
    const quebrada = entrega({ abrir: () => { throw new Error('sem janela') } })
    quebrada.e.entregar(aviso())
    expect(() => FakeNotification.criadas[0].emit('click')).not.toThrow()
  })

  it('o destino é plugável: celular não mostra no Windows; ambos, nos dois', () => {
    const celular = vi.fn()
    const { e } = entrega({ destino: () => 'celular', celular })
    e.entregar(aviso())
    expect(FakeNotification.criadas).toHaveLength(0)
    expect(celular).toHaveBeenCalledTimes(1)
    const ambos = entrega({ destino: () => 'ambos', celular })
    ambos.e.entregar(aviso())
    expect(FakeNotification.criadas).toHaveLength(1)
    expect(celular).toHaveBeenCalledTimes(2)
  })

  it('texto longo é cortado com reticências, sem quebrar palavra', () => {
    expect(curto('a '.repeat(10).trim(), 50)).toBe('a a a a a a a a a a')
    const longo = curto('O preço da passagem para Lisboa caiu bastante hoje de manhã', 30)
    expect(longo.endsWith('…')).toBe(true)
    expect(longo.length).toBeLessThanOrEqual(30)
  })
})
