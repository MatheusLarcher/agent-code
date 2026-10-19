// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BrilhoDasTarefas, criarIsBusy, motivoAcordado, OCIOSO_PARA_ESCURECER_S, type BrilhoIo, type EstadoAcordado } from './acordado'

/** O `isBusy` composto do sleepGuard (turno OU tarefa na tomada) e o brilho das tarefas. */

const base: EstadoAcordado = { turnoOcupado: false, turnoLigado: true, tarefaAtiva: false, naBateria: false, tarefasLigado: true }

describe('motivo para manter o PC acordado', () => {
  it('turno ocupado segura (com o interruptor dele); tarefa ativa só na tomada e com o interruptor dela', () => {
    expect(motivoAcordado({ ...base, turnoOcupado: true })).toBe('turno')
    expect(motivoAcordado({ ...base, turnoOcupado: true, turnoLigado: false })).toBeNull()
    expect(motivoAcordado({ ...base, tarefaAtiva: true })).toBe('tarefas')
    expect(motivoAcordado({ ...base, tarefaAtiva: true, naBateria: true })).toBeNull()
    expect(motivoAcordado({ ...base, tarefaAtiva: true, tarefasLigado: false })).toBeNull()
    expect(motivoAcordado(base)).toBeNull()
    // O turno ganha: o brilho só é das tarefas quando elas são o ÚNICO motivo.
    expect(motivoAcordado({ ...base, turnoOcupado: true, tarefaAtiva: true })).toBe('turno')
  })
})

function brilhoFalso(inicial: number | null = 70) {
  let atual = inicial
  const io: BrilhoIo & { atual(): number | null } = {
    ler: vi.fn(async () => atual),
    definir: vi.fn(async (n: number) => {
      if (atual === null) return false
      atual = n
      return true
    }),
    definirAoSair: vi.fn((n: number) => {
      atual = n
    }),
    atual: () => atual
  }
  return io
}

describe('isBusy composto + brilho', () => {
  it('tomada/bateria/interruptor/sem tarefa; escurece só com o usuário longe e devolve o brilho ao voltar', async () => {
    const io = brilhoFalso(70)
    const brilho = new BrilhoDasTarefas(io)
    const estado = { turno: false, ativa: true, bateria: false, ocioso: 0, cfg: {} as { manterAcordadoTarefas?: boolean } }
    const isBusy = criarIsBusy({
      turnoOcupado: () => estado.turno,
      config: () => estado.cfg,
      tarefaAtiva: () => estado.ativa,
      naBateria: () => estado.bateria,
      ociosoSegundos: () => estado.ocioso,
      brilho
    })
    expect(isBusy()).toBe(true)
    await brilho.ocioso()
    expect(io.atual()).toBe(70) // usuário no PC: não escurece
    estado.ocioso = OCIOSO_PARA_ESCURECER_S
    isBusy()
    await brilho.ocioso()
    expect(io.atual()).toBe(0)
    estado.ocioso = 3 // voltou
    isBusy()
    await brilho.ocioso()
    expect(io.atual()).toBe(70)
    estado.bateria = true
    expect(isBusy()).toBe(false)
    estado.bateria = false
    estado.cfg = { manterAcordadoTarefas: false }
    expect(isBusy()).toBe(false)
    estado.cfg = {}
    estado.ativa = false
    expect(isBusy()).toBe(false)
    estado.turno = true
    expect(isBusy()).toBe(true)
  })

  it('soltar o pedido devolve o brilho; fechar o app também; sem WMI não tenta de novo', async () => {
    const io = brilhoFalso(55)
    const brilho = new BrilhoDasTarefas(io)
    brilho.atualizar(true)
    await brilho.ocioso()
    expect(io.atual()).toBe(0)
    brilho.restaurarAoSair()
    expect(io.atual()).toBe(55)
    const semWmi = brilhoFalso(null)
    const b2 = new BrilhoDasTarefas(semWmi)
    b2.atualizar(true)
    await b2.ocioso()
    b2.atualizar(false)
    b2.atualizar(true)
    await b2.ocioso()
    expect(semWmi.ler).toHaveBeenCalledTimes(1)
    expect(semWmi.definir).not.toHaveBeenCalled()
  })

  it('dependência que lança não derruba o guard', () => {
    const isBusy = criarIsBusy({
      turnoOcupado: () => { throw new Error('x') },
      config: () => { throw new Error('y') },
      tarefaAtiva: () => true,
      naBateria: () => { throw new Error('z') },
      ociosoSegundos: () => 0
    })
    expect(isBusy()).toBe(true)
  })
})
