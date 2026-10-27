import { describe, expect, it } from 'vitest'
import { UpdateInstaller, type InstallDirProcessInfo, type UpdateInstallerDeps } from './updateInstaller'

interface Harness {
  installer: UpdateInstaller
  deps: UpdateInstallerDeps
  calls: string[]
  lines: string[]
  phase: { value: string }
}

function harness(overrides: Partial<UpdateInstallerDeps> & { processes?: InstallDirProcessInfo[][] } = {}): Harness {
  const calls: string[] = []
  const lines: string[] = []
  const phase = { value: 'pronta' }
  const processLists = overrides.processes ?? []
  const deps: UpdateInstallerDeps = {
    log: (line) => lines.push(line),
    blockedBy: () => null,
    pendingInstaller: () => 'C:\\cache\\AgentCode-setup.exe',
    pendingVersion: () => '0.2.0',
    fileExists: () => true,
    markInstalling: () => {
      calls.push('markInstalling')
      phase.value = 'instalando'
      return true
    },
    markReady: (error) => {
      calls.push(`markReady:${error ?? ''}`)
      phase.value = 'pronta'
    },
    hold: () => calls.push('hold'),
    steps: () => [
      { name: 'flush', timeoutMs: 1_000, run: () => calls.push('step:flush') },
      { name: 'persistência', timeoutMs: 1_000, run: async () => void calls.push('step:persistência') },
      { name: 'voz', timeoutMs: 1_000, run: () => calls.push('step:voz') }
    ],
    listProcesses: async () => {
      calls.push('list')
      // A primeira chamada é a sonda; as seguintes seguem a lista de cenários (a última se repete).
      const index = calls.filter((c) => c === 'list').length - 2
      if (index < 0) return []
      return processLists[Math.min(index, processLists.length - 1)] ?? []
    },
    killProcess: async (pid) => void calls.push(`kill:${pid}`),
    rememberAttempt: (version) => calls.push(`remember:${version}`),
    markQuitReady: () => calls.push('quitReady'),
    quitAndInstall: () => calls.push('quitAndInstall'),
    stillInstalling: () => phase.value === 'instalando',
    quitApp: () => calls.push('quitApp'),
    dryRun: false,
    wait: async () => void calls.push('wait'),
    orphanGraceMs: 50,
    orphanPollMs: 1,
    ...overrides
  }
  return { installer: new UpdateInstaller(deps), deps, calls, lines, phase }
}

describe('UpdateInstaller', () => {
  it('ordem: sonda → instalando → retenção → passos → conferência → marcador → quitAndInstall', async () => {
    const h = harness()
    const result = await h.installer.installNow('botão')
    expect(result).toEqual({ ok: true })
    expect(h.calls).toEqual([
      'list',
      'markInstalling',
      'hold',
      'step:flush',
      'step:persistência',
      'step:voz',
      'list',
      'remember:0.2.0',
      'quitReady',
      'quitAndInstall'
    ])
    expect(h.lines.some((l) => l.includes('nenhum processo da pasta de instalação vivo'))).toBe(true)
    expect(h.lines.some((l) => l.includes('instalador disparado'))).toBe(true)
  })

  it('agente que começou DURANTE a sonda de processos: recusa passageira, sem fechar nada', async () => {
    let asked = 0
    const h = harness({ blockedBy: () => (++asked >= 2 ? 'A conversa "x" está com um turno em andamento.' : null) })
    const result = await h.installer.installNow('botão')
    expect(result).toEqual({ ok: false, message: 'A conversa "x" está com um turno em andamento.', transient: true })
    expect(h.calls).toEqual(['list'])
    expect(h.phase.value).toBe('pronta')
    expect(h.installer.busy).toBe(false)
  })

  it('o log é esperado em disco antes de o app sair — no disparo real e no ensaio', async () => {
    // O `wait` injetado também registra 'wait' (é o prazo do flush): fica fora da ordem conferida.
    const semEspera = (calls: string[]): string[] => calls.filter((c) => c !== 'wait')
    const real = harness({ flushLog: async () => void real.calls.push('flushLog') })
    await real.installer.installNow('botão')
    expect(semEspera(real.calls).slice(-4)).toEqual(['remember:0.2.0', 'flushLog', 'quitReady', 'quitAndInstall'])
    expect(real.lines.at(-1)).toContain('instalador disparado')
    const dry = harness({ dryRun: true, flushLog: async () => void dry.calls.push('flushLog') })
    await dry.installer.installNow('agendamento')
    expect(semEspera(dry.calls).slice(-3)).toEqual(['flushLog', 'quitReady', 'quitApp'])
    // Um flush que nunca resolve não segura a saída (prazo de 2 s pelo `wait` injetado).
    const stuck = harness({ flushLog: () => new Promise<void>(() => undefined) })
    await stuck.installer.installNow('botão')
    expect(stuck.calls.at(-1)).toBe('quitAndInstall')
  })

  it('agente trabalhando: recusa com o motivo e não fecha nada', async () => {
    const h = harness({ blockedBy: () => 'A conversa "mapa" está com um turno em andamento.' })
    const result = await h.installer.installNow('botão')
    // `transient`: o agendamento pode continuar esperando em vez de cancelar.
    expect(result).toEqual({ ok: false, message: 'A conversa "mapa" está com um turno em andamento.', transient: true })
    expect(h.calls).toEqual([])
  })

  it('nada pronto ou arquivo sumido: recusa; arquivo sumido volta a pronta com o motivo', async () => {
    const none = harness({ pendingInstaller: () => null })
    expect((await none.installer.installNow('botão')).ok).toBe(false)
    expect(none.calls).toEqual([])
    const gone = harness({ fileExists: () => false })
    const result = await gone.installer.installNow('agendamento')
    expect(result.ok).toBe(false)
    expect(gone.calls).toEqual(['markReady:O arquivo da atualização não está mais no disco; a próxima verificação baixa de novo.'])
  })

  it('sonda de processos falha: app continua aberto, nenhum passo roda', async () => {
    const h = harness({ listProcesses: async () => { throw new Error('powershell.exe não respondeu em 20000 ms') } })
    const result = await h.installer.installNow('botão')
    expect(result).toEqual({ ok: false, message: 'Não foi possível conferir os processos da pasta de instalação: powershell.exe não respondeu em 20000 ms' })
    expect(h.calls.filter((c) => c.startsWith('step:'))).toEqual([])
    expect(h.calls).not.toContain('markInstalling')
  })

  it('processo da pasta some sozinho dentro do prazo: não força', async () => {
    const pg = { pid: 4100, path: 'C:\\app\\resources\\postgres\\bin\\postgres.exe' }
    const h = harness({ processes: [[pg], [pg], []] })
    expect(await h.installer.installNow('botão')).toEqual({ ok: true })
    expect(h.calls.filter((c) => c.startsWith('kill:'))).toEqual([])
    expect(h.calls.filter((c) => c === 'wait').length).toBe(2)
    expect(h.calls.at(-1)).toBe('quitAndInstall')
  })

  it('órfão depois do prazo é forçado uma vez e a instalação segue', async () => {
    const chrome = { pid: 777, path: 'C:\\app\\resources\\ms-playwright\\chrome.exe' }
    const h = harness({ processes: [[chrome]] })
    expect(await h.installer.installNow('botão')).toEqual({ ok: true })
    expect(h.calls.filter((c) => c.startsWith('kill:'))).toEqual(['kill:777'])
    expect(h.lines.some((l) => l.includes('órfãos após o prazo: 777'))).toBe(true)
    expect(h.lines.some((l) => l.includes('ainda vivos depois da força'))).toBe(true)
    expect(h.calls.at(-1)).toBe('quitAndInstall')
  })

  it('ensaio (dryRun): faz tudo, não chama o instalador e sai do app', async () => {
    const h = harness({ dryRun: true })
    expect(await h.installer.installNow('botão')).toEqual({ ok: true })
    expect(h.calls).not.toContain('quitAndInstall')
    expect(h.calls).not.toContain('remember:0.2.0')
    expect(h.calls.slice(-2)).toEqual(['quitReady', 'quitApp'])
    expect(h.lines.some((l) => l.startsWith('ensaio: nenhum processo da pasta de instalação vivo'))).toBe(true)
  })

  it('passo que falha ou estoura o prazo é registrado e a sequência continua', async () => {
    const h = harness({
      steps: () => [
        { name: 'quebra', timeoutMs: 1_000, run: () => { throw new Error('boom') } },
        { name: 'lento', timeoutMs: 5, run: () => new Promise(() => undefined) },
        { name: 'ok', timeoutMs: 1_000, run: () => void 0 }
      ]
    })
    expect(await h.installer.installNow('botão')).toEqual({ ok: true })
    expect(h.lines.some((l) => l.includes('passo "quebra": falhou (boom)'))).toBe(true)
    expect(h.lines.some((l) => l.includes('passo "lento": estourou o prazo de 5 ms'))).toBe(true)
    expect(h.lines.some((l) => l.includes('passo "ok": ok em'))).toBe(true)
  })

  it('updater recusa a instalação: volta a pronta com o motivo e o app sai sem instalar', async () => {
    const h = harness({
      quitAndInstall: () => {
        h.calls.push('quitAndInstall')
        h.phase.value = 'pronta' // o updater emitiu 'error' durante o install()
      }
    })
    const result = await h.installer.installNow('botão')
    expect(result.ok).toBe(false)
    expect(h.calls.slice(-3)).toEqual(['quitAndInstall', 'markReady:O instalador não subiu: o updater recusou a instalação (ver as linhas "updater" acima)', 'quitApp'])
  })

  it('listagem falha depois do fechamento: sai sem instalar', async () => {
    let lists = 0
    const h = harness({
      listProcesses: async () => {
        lists += 1
        if (lists === 1) return []
        throw new Error('powershell morreu')
      }
    })
    const result = await h.installer.installNow('agendamento')
    expect(result.ok).toBe(false)
    expect(h.calls).not.toContain('quitAndInstall')
    expect(h.calls.slice(-2)).toEqual(['quitReady', 'quitApp'])
    expect(h.lines.some((l) => l.includes('saindo SEM instalar'))).toBe(true)
  })

  it('segunda chamada durante a instalação é recusada', async () => {
    let release: () => void = () => undefined
    const h = harness({
      steps: () => [{ name: 'segura', timeoutMs: 10_000, run: () => new Promise<void>((resolve) => { release = resolve }) }]
    })
    const first = h.installer.installNow('botão')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.installer.busy).toBe(true)
    expect(await h.installer.installNow('botão')).toEqual({ ok: false, message: 'Já há uma instalação em andamento.' })
    release()
    expect(await first).toEqual({ ok: true })
  })

  describe('atualização rápida', () => {
    const never = (): Promise<void> => new Promise(() => undefined)

    it('pasta pronta: troca rápida no lugar do instalador', async () => {
      const h = harness({
        wait: never,
        prepareFastSwap: async () => (h.calls.push('prepare'), true),
        launchFastSwap: () => void h.calls.push('swap')
      })
      expect(await h.installer.installNow('botão')).toEqual({ ok: true })
      expect(h.calls).toEqual([
        'list', 'markInstalling', 'hold', 'prepare',
        'step:flush', 'step:persistência', 'step:voz', 'list',
        'remember:0.2.0', 'swap', 'quitReady', 'quitApp'
      ])
      expect(h.calls).not.toContain('quitAndInstall')
    })

    it('extração indisponível: cai no instalador', async () => {
      const h = harness({
        wait: never,
        prepareFastSwap: async () => false,
        launchFastSwap: () => void h.calls.push('swap')
      })
      expect(await h.installer.installNow('botão')).toEqual({ ok: true })
      expect(h.calls).not.toContain('swap')
      expect(h.calls.at(-1)).toBe('quitAndInstall')
      expect(h.lines.some((l) => l.includes('usando o instalador'))).toBe(true)
    })

    it('o script da troca não sobe: cai no instalador', async () => {
      const h = harness({
        wait: never,
        prepareFastSwap: async () => true,
        launchFastSwap: () => {
          throw new Error('spawn falhou')
        }
      })
      expect(await h.installer.installNow('botão')).toEqual({ ok: true })
      expect(h.calls.at(-1)).toBe('quitAndInstall')
      expect(h.lines.some((l) => l.includes('troca rápida não subiu (spawn falhou)'))).toBe(true)
    })

    it('extração demorando demais: desiste dela e usa o instalador', async () => {
      const h = harness({
        prepareFastSwap: () => new Promise<boolean>(() => undefined),
        launchFastSwap: () => void h.calls.push('swap')
      })
      expect(await h.installer.installNow('botão')).toEqual({ ok: true })
      expect(h.calls).not.toContain('swap')
      expect(h.calls.at(-1)).toBe('quitAndInstall')
    })

    it('ensaio não prepara nem troca', async () => {
      const h = harness({
        dryRun: true,
        prepareFastSwap: async () => (h.calls.push('prepare'), true),
        launchFastSwap: () => void h.calls.push('swap')
      })
      await h.installer.installNow('botão')
      expect(h.calls).not.toContain('prepare')
      expect(h.calls).not.toContain('swap')
    })
  })
})
