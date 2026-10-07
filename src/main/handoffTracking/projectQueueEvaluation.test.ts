// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { PoAgentRequest, PoAgentResult } from '../po/poAgentQuery'
import {
  PROJECT_RECORDS_KEEP,
  createProjectEvaluator,
  parseReplyVerdict,
  parseTurnVerdict,
  type ProjectEvaluationInput
} from './projectQueueEvaluation'
import type { ProjectGit } from './projectQueueGit'

/**
 * A avaliação do PO na fila do projeto, com o SDK simulado: o formato fixo,
 * as saídas fixas na falha (ESPERAR na vez, RETOMAR_A na resposta), o que vai
 * para o PO (histórico do A num arquivo, prompts completos do B, git) e o que
 * ele alterou (git antes × depois), tudo num registro.
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function records(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-aval-'))
  dirs.push(dir)
  return dir
}

const envio = (lote: string, ordem: number, status: HandoffEnvio['status'], conteudo: string): HandoffEnvio =>
  ({
    id: `${lote}-${ordem}`,
    loteId: lote,
    conversationId: `conv-${lote}`,
    ordem,
    arquivo: `0${ordem}.md`,
    status,
    motivo: status === 'incompleta' ? 'faltou 1 de 2 entregas: [b]' : null,
    conteudo,
    estimativaTotal: 40,
    criadoEm: '2026-10-06T10:00:00.000Z',
    enviadoEm: status === 'na_fila' ? null : '2026-10-06T10:05:00.000Z'
  }) as HandoffEnvio

function input(kind: 'vez' | 'resposta', over: Partial<ProjectEvaluationInput> = {}): ProjectEvaluationInput {
  return {
    kind,
    cwd: 'C:/proj',
    a: {
      plan: { loteId: 'a', conversationId: 'conv-a', planTitulo: 'Plano A', addedAt: 'x' },
      envios: [envio('a', 1, 'incompleta', 'PROMPT-A-1')],
      motivo: 'o prompt anterior não foi concluído: faltou [b]',
      stoppedMinutes: 31
    },
    b: {
      plan: { loteId: 'b', conversationId: 'conv-b', planTitulo: 'Plano B', addedAt: 'x' },
      envios: [envio('b', 1, 'na_fila', 'PROMPT-B-1 completo'), envio('b', 2, 'na_fila', 'PROMPT-B-2 completo')]
    },
    signal: new AbortController().signal,
    ...over
  }
}

const done = (text: string): PoAgentResult => ({ state: 'completed', text, transcript: text, tools: [], turns: 2 })

function git(before: Map<string, string>, after = before): ProjectGit {
  let calls = 0
  return {
    dirty: async () => [...before.keys()],
    head: async () => 'abc',
    snapshot: async () => (calls++ === 0 ? before : after)
  }
}

function evaluator(run: (request: PoAgentRequest) => Promise<PoAgentResult>, recordsDir: string | null, g = git(new Map())) {
  return createProjectEvaluator({
    recordsDir,
    git: g,
    gitEvidence: async () => ({ status: [' M src/a.ts'], diffStat: [' src/a.ts | 2 +-'], log: ['abc1234 feat: a'] }),
    history: async (id) => `# Conversa ${id}\n## Usuário\noi\n## Agente\nparei: preciso da chave da API`,
    runtime: async () => ({ model: 'claude-opus-5-5', env: { X: '1' } }),
    run
  })
}

describe('o formato fixo da resposta', () => {
  it('lê a última linha COMECAR/ESPERAR (com ou sem acento e negrito)', () => {
    expect(parseTurnVerdict('Olhei tudo.\nCOMECAR | o B mexe só no backend')).toEqual({ decisao: 'COMECAR', motivo: 'o B mexe só no backend' })
    expect(parseTurnVerdict('**COMEÇAR** | pode ir')).toEqual({ decisao: 'COMECAR', motivo: 'pode ir' })
    expect(parseTurnVerdict('ESPERAR | o A deixou App.tsx pela metade')).toMatchObject({ decisao: 'ESPERAR' })
    expect(parseTurnVerdict('acho que dá para começar')).toBeNull()
    expect(parseTurnVerdict('COMECAR |   ')).toBeNull()
  })

  it('lê RETOMAR_A/ESPERAR_B/PERGUNTAR', () => {
    expect(parseReplyVerdict('RETOMAR_A | a resposta destrava o A')).toEqual({ decisao: 'RETOMAR_A', motivo: 'a resposta destrava o A' })
    expect(parseReplyVerdict('esperar_b | o B termina em 10 min')).toMatchObject({ decisao: 'ESPERAR_B' })
    expect(parseReplyVerdict('PERGUNTAR | voltar ao A já?')).toMatchObject({ decisao: 'PERGUNTAR', motivo: 'voltar ao A já?' })
    expect(parseReplyVerdict('COMECAR | x')).toBeNull()
  })
})

describe('a avaliação dos 30 min (vez)', () => {
  it('o PO recebe o motivo, o histórico do A num arquivo, os prompts completos do B e o git; COMECAR vale', async () => {
    const dir = await records()
    const run = vi.fn(async (request: PoAgentRequest) => {
      expect(request.prompt).toContain('POR QUE O A PAROU: o prompt anterior não foi concluído: faltou [b]')
      expect(request.prompt).toContain('PROMPT-B-1 completo')
      expect(request.prompt).toContain('PROMPT-B-2 completo')
      expect(request.prompt).toContain('GIT DA PASTA')
      expect(request.prompt).toContain('abc1234 feat: a')
      expect(request.prompt).toContain('há 31 min')
      const historyPath = /HISTÓRICO DA CONVERSA DO A \(leia o fim primeiro\): (.+)/.exec(request.prompt)?.[1]?.trim()
      expect(historyPath).toBeTruthy()
      expect(await readFile(historyPath!, 'utf8')).toContain('preciso da chave da API')
      expect(request.additionalDirectories?.[0]).toBe(dirname(historyPath!))
      expect(request.env).toEqual({ X: '1' })
      return done('Li o histórico.\nCOMECAR | o B não toca no que o A deixou')
    })
    const out = await evaluator(run, dir)(input('vez'))
    expect(out).toMatchObject({ cancelled: false, decisao: 'COMECAR', motivo: 'o B não toca no que o A deixou', falhou: false, alterados: [] })
    expect(out.registro).toBeTruthy()
    const record = await readFile(join(out.registro!, 'avaliacao.md'), 'utf8')
    expect(record).toContain('- decisão: COMECAR')
    expect(record).toContain('PROMPT-B-2 completo')
  })

  it('falha, prazo, teto de turnos e formato errado → ESPERAR (falha fechada)', async () => {
    const dir = await records()
    const cases: PoAgentResult[] = [
      { state: 'failed', text: '', transcript: '', tools: [], turns: 0, error: 'sem login' },
      { state: 'timeout', text: 'COMECAR | quase', transcript: '', tools: [], turns: 9 },
      { state: 'max-turns', text: '', transcript: '', tools: [], turns: 30 },
      done('Acho que pode começar.')
    ]
    for (const res of cases) {
      const out = await evaluator(async () => res, dir)(input('vez'))
      expect(out).toMatchObject({ decisao: 'ESPERAR', falhou: true })
      expect(out.motivo).toMatch(/^o PO não conseguiu avaliar \(/)
    }
    expect((await evaluator(async () => cases[1], dir)(input('vez'))).motivo).toContain('passou de 10 min')
    expect((await evaluator(async () => cases[3], dir)(input('vez'))).motivo).toContain('resposta fora do formato')
  })

  it('o git antes × depois diz o que o PO alterou', async () => {
    const before = new Map([['src/a.ts', ' M|1|10']])
    const after = new Map([['src/a.ts', ' M|2|12'], ['novo.md', '??|3|4']])
    const out = await evaluator(async () => done('ESPERAR | x'), await records(), git(before, after))(input('vez'))
    expect(out.alterados).toEqual(['novo.md', 'src/a.ts'])
    expect(await readFile(join(out.registro!, 'avaliacao.md'), 'utf8')).toContain('- o PO alterou: novo.md, src/a.ts')
  })

  it('cancelada no meio (o usuário voltou): não vale nada', async () => {
    const abort = new AbortController()
    const out = await evaluator(async () => {
      abort.abort()
      return { state: 'aborted', text: '', transcript: '', tools: [], turns: 1 }
    }, await records())(input('vez', { signal: abort.signal }))
    expect(out.cancelled).toBe(true)
  })

  it(`guarda só os ${PROJECT_RECORDS_KEEP} registros mais novos`, async () => {
    const dir = await records()
    let t = Date.parse('2026-10-06T10:00:00.000Z')
    const evaluate = createProjectEvaluator({
      recordsDir: dir,
      git: git(new Map()),
      gitEvidence: async () => null,
      history: async () => '',
      runtime: async () => ({ model: 'm' }),
      run: async () => done('ESPERAR | x'),
      now: () => (t += 1_000)
    })
    for (let i = 0; i < PROJECT_RECORDS_KEEP + 3; i++) await evaluate(input('vez'))
    expect((await readdir(dir)).length).toBe(PROJECT_RECORDS_KEEP)
  })
})

describe('a resposta guardada (A com o B rodando)', () => {
  it('o PO lê a resposta e o andamento do B; RETOMAR_A/ESPERAR_B/PERGUNTAR valem', async () => {
    const dir = await records()
    const run = vi.fn(async (request: PoAgentRequest) => {
      expect(request.prompt).toContain('A RESPOSTA DO USUÁRIO NO A:\nA chave é XYZ, pode seguir')
      expect(request.prompt).toContain('O ANDAMENTO DO B: nenhum dos 2 prompts saiu')
      return done('RETOMAR_A | a resposta destrava o A')
    })
    const reply = { reply: 'A chave é XYZ, pode seguir' }
    expect(await evaluator(run, dir)(input('resposta', reply))).toMatchObject({ decisao: 'RETOMAR_A', falhou: false })
    expect(await evaluator(async () => done('ESPERAR_B | o B acaba logo'), dir)(input('resposta', reply))).toMatchObject({ decisao: 'ESPERAR_B' })
    expect(await evaluator(async () => done('PERGUNTAR | volto ao A agora?'), dir)(input('resposta', reply))).toMatchObject({
      decisao: 'PERGUNTAR',
      pergunta: 'volto ao A agora?'
    })
  })

  it('falha, prazo ou formato errado → RETOMAR_A (o usuário está presente)', async () => {
    const dir = await records()
    for (const res of [
      { state: 'failed', text: '', transcript: '', tools: [], turns: 0 } as PoAgentResult,
      { state: 'timeout', text: '', transcript: '', tools: [], turns: 0 } as PoAgentResult,
      done('não sei')
    ]) {
      const out = await evaluator(async () => res, dir)(input('resposta', { reply: 'oi' }))
      expect(out).toMatchObject({ decisao: 'RETOMAR_A', falhou: true })
      expect(out.motivo).toContain('a sua resposta não fica presa')
    }
  })
})

function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '')
}
