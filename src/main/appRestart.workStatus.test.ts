// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AppRestartCoordinator, type RestartActivity, type RestartHost } from './appRestart'

// A guarda da troca de banco (workStatus/othersWorking) conta só trabalho de verdade;
// a do app_restart (status) continua com o latch de incerteza, como antes.

const host: RestartHost = {
  arm: async () => ({ commit: async () => undefined, cancel: async () => undefined }),
  flush: async () => undefined,
  quit: () => undefined,
  report: () => undefined
}

function coordinator(): AppRestartCoordinator {
  return new AppRestartCoordinator(host)
}

describe('AppRestartCoordinator.workStatus — a guarda da troca de banco', () => {
  it('conversa retomada (background desconhecido) ou que já lançou trabalho destacado: a troca segue; o app_restart continua barrando', () => {
    const restart = coordinator()
    restart.register('retomada', () => ({ busy: false, unsafe: 'Estado de background desconhecido.', backgroundTasks: null }))
    restart.register('destacada', () => ({ busy: false, unsafe: 'Trabalho autônomo sem prova de término.', backgroundTasks: 0 }))
    expect(restart.workStatus()).toMatchObject({ idle: true, blockedBy: null, sessions: 2 })
    expect(restart.status()).toMatchObject({ idle: false, blockedBy: 'retomada: Estado de background desconhecido.' })
  })

  it('trabalho de verdade segura a troca, com o nome da conversa na mensagem', () => {
    const cases: Array<[RestartActivity, string]> = [
      [{ busy: true }, 'A conversa "Relatório" está com um turno em andamento.'],
      [{ busy: false, autonomousCallOpen: true }, 'A conversa "Relatório" tem uma ferramenta ainda rodando.'],
      [{ busy: false, backgroundTasks: 2 }, 'A conversa "Relatório" tem tarefas em background rodando.'],
      [{ busy: false, persistenceUnverified: true }, 'O histórico da conversa "Relatório" ainda não foi confirmado no banco.']
    ]
    for (const [activity, message] of cases) {
      const restart = coordinator()
      restart.register('c1', () => activity)
      expect(restart.workStatus((id) => (id === 'c1' ? 'Relatório' : id))).toMatchObject({ idle: false, blockedBy: message })
    }
  })

  it('start/send em andamento segura; ao terminar, libera', () => {
    const restart = coordinator()
    restart.register('c1', () => ({ busy: false }))
    const done = restart.enter()
    expect(restart.workStatus().idle).toBe(false)
    done()
    expect(restart.workStatus().idle).toBe(true)
  })

  it('othersWorking (a ferramenta app_postgres_nuvem): ignora o turno de quem pergunta, não o das outras', () => {
    const restart = coordinator()
    const caller = restart.register('quem-pede', () => ({ busy: true, unsafe: 'Estado de background desconhecido.' }))
    expect(caller.othersWorking()).toBeUndefined()
    let otherBusy = false
    restart.register('outra', () => ({ busy: otherBusy }))
    expect(caller.othersWorking()).toBeUndefined()
    otherBusy = true
    expect(caller.othersWorking()).toBe('A conversa "outra" está com um turno em andamento.')
  })
})
