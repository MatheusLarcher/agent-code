// Só para testes: Profiler falso do JS Self-Profiling e um trace de exemplo.
import { vi } from 'vitest'
import { SAMPLE_MS, type ProfilerTrace } from './jsProfiler'

export interface FakeProfilerInstance {
  options: unknown
  trace: ProfilerTrace
  stop: () => Promise<ProfilerTrace>
}

/** Instala `globalThis.Profiler` falso: registra a ordem de criação/parada; cada instância devolve o trace que o teste definir. */
export function fakeProfiler(options: { throws?: boolean } = {}): { log: string[]; instances: FakeProfilerInstance[] } {
  const log: string[] = []
  const instances: FakeProfilerInstance[] = []
  const throws = options.throws === true
  class FakeProfiler implements FakeProfilerInstance {
    readonly sampleInterval = SAMPLE_MS
    trace: ProfilerTrace = { resources: [], frames: [], stacks: [], samples: [] }
    private readonly id: number
    constructor(readonly options: unknown) {
      if (throws) throw new Error('JS profiling is disabled by Document Policy')
      this.id = instances.length
      instances.push(this)
      log.push(`novo ${this.id}`)
    }
    stop = async (): Promise<ProfilerTrace> => {
      log.push(`parou ${this.id}`)
      return this.trace
    }
  }
  vi.stubGlobal('Profiler', FakeProfiler)
  return { log, instances }
}

/**
 * Trace de exemplo: render < flush < applyFeed (index-abc.js), uma folha
 * anônima em vendor.js e saveConversations. Amostras de 10 ms.
 */
export function sampleTrace(): ProfilerTrace {
  return {
    resources: ['file:///C:/Users/Fulano/out/renderer/assets/index-abc.js', 'file:///C:/x/vendor.js?v=2'],
    frames: [
      { name: 'render', resourceId: 0, line: 1, column: 10 },
      { name: 'flush', resourceId: 0, line: 1, column: 200 },
      { name: 'applyFeed', resourceId: 0, line: 1, column: 3400 },
      { name: '', resourceId: 1, line: 5, column: 7 },
      { name: 'saveConversations', resourceId: 0, line: 2, column: 50 }
    ],
    stacks: [
      { frameId: 0 },
      { frameId: 1, parentId: 0 },
      { frameId: 2, parentId: 1 }, // 2: applyFeed < flush < render
      { frameId: 3, parentId: 1 }, // 3: (anônima) < flush < render
      { frameId: 2, parentId: 0 }, // 4: applyFeed < render
      { frameId: 4, parentId: 0 } // 5: saveConversations < render
    ],
    samples: [
      { timestamp: 90, stackId: 5 }, // fora do quadro [100, 180]
      { timestamp: 100, stackId: 2 },
      { timestamp: 110, stackId: 2 },
      { timestamp: 120, stackId: 4 },
      { timestamp: 130, stackId: 3 },
      { timestamp: 140, stackId: 1 },
      { timestamp: 150 }, // sem pilha: ocioso/layout
      { timestamp: 160, stackId: 5 },
      { timestamp: 170, stackId: 2 },
      { timestamp: 180 }, // ocioso: cada amostra vale o trecho até a próxima
      { timestamp: 300, stackId: 3 } // fora do quadro
    ]
  }
}
