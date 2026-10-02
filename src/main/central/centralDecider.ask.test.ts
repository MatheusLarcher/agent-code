// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CentralOption, CentralRouteResult } from '../../shared/central'
import { decideRoute, fallbackRoute } from './centralDecider'
import { ALPHA, SANDBOX_ROOT, SUMMARIES, fakeAsk, makeIndex, pick, recent, routeRequest, stateOf, target } from './centralDeciderKit'

// "Para onde vai?": abaixo do piso, TypeSafe que falha, chave não oferecida, forceAsk e exclude.

/** As opções sem a probabilidade (a ordem e os destinos), para comparar com `target.*`. */
const targets = (result: CentralRouteResult) => (result.kind === 'ask' ? result.options.map((o) => o.target) : [])
const probabilities = (result: CentralRouteResult) => (result.kind === 'ask' ? result.options.map((o) => o.probability) : [])

function expectProbabilities(result: CentralRouteResult, expected: number[]): void {
  const actual = probabilities(result)
  expect(actual).toHaveLength(expected.length)
  expected.forEach((p, i) => expect(actual[i]).toBeCloseTo(p, 6))
}

describe('abaixo do piso → ask low-confidence com os destinos mais prováveis', () => {
  it('no `continua`: os recentes pela probabilidade + "nova em <projeto mais provável>" + sandbox, ordenados', async () => {
    const { ask, calls } = fakeAsk({
      first: {
        continua: pick('d1', 0.5, { d1: 0.5, d2: 0.2, outro_assunto: 0.3 }),
        projeto: pick('p2', 0.7, { p1: 0.2, p2: 0.7, sem_projeto: 0.1 })
      }
    })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1'), recent('b1')] }), makeIndex(), { ask })

    expect(result).toMatchObject({ kind: 'ask', reason: 'low-confidence', best: 0 })
    expect(targets(result)).toEqual([target.a1, target.newBeta, target.b1, target.newSandbox])
    // "nova em beta" = P(outro assunto) × P(beta); sandbox = P(outro assunto) × P(sem projeto).
    expectProbabilities(result, [0.5, 0.21, 0.2, 0.03])
    expect(calls).toHaveLength(1)
  })

  it('no `projeto`: sem 2ª chamada; o projeto mais provável vira "nova em…"', async () => {
    const { ask, calls } = fakeAsk({
      first: {
        continua: pick('outro_assunto', 0.9, { d1: 0.1, outro_assunto: 0.9 }),
        projeto: pick('p1', 0.55, { p1: 0.55, p2: 0.4, sem_projeto: 0.05 })
      }
    })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1')] }), makeIndex(), { ask })

    expect(result).toMatchObject({ kind: 'ask', reason: 'low-confidence', best: 0 })
    expect(targets(result)).toEqual([target.newAlpha, target.a1, target.newSandbox])
    expectProbabilities(result, [0.495, 0.1, 0.045])
    expect(calls).toHaveLength(1)
  })

  it('na 2ª chamada: junta `continua` e a 2ª chamada; o mesmo destino pelos dois caminhos aparece uma vez (somado)', async () => {
    const { ask, calls } = fakeAsk({
      first: {
        continua: pick('outro_assunto', 0.9, { d1: 0.1, outro_assunto: 0.9 }),
        projeto: pick('p1', 0.8, { p1: 0.8, p2: 0.15, sem_projeto: 0.05 })
      },
      second: { conversa: pick('c1', 0.4, { c1: 0.45, c2: 0.35, nova: 0.2 }) }
    })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1')] }), makeIndex(), { ask })

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ kind: 'ask', reason: 'low-confidence', best: 0 })
    expect(targets(result)).toEqual([target.a1, target.a2, target.newAlpha, target.newSandbox])
    // a1: 0,1 (recente) + 0,9 × 0,8 × 0,45 (2ª chamada).
    expectProbabilities(result, [0.424, 0.252, 0.144, 0.045])
  })

  it('no máximo 3 prováveis, mais "nova em…" e sandbox', async () => {
    const { ask } = fakeAsk({
      first: {
        continua: pick('d1', 0.3, { d1: 0.3, d2: 0.25, d3: 0.2, d4: 0.15, outro_assunto: 0.1 }),
        projeto: pick('p1', 0.9, { p1: 0.9, p2: 0.05, sem_projeto: 0.05 })
      }
    })
    const req = routeRequest('x', { recent: [recent('a1'), recent('a2'), recent('b1'), recent('s1')] })
    const result = await decideRoute(req, makeIndex(), { ask })

    expect(targets(result)).toEqual([target.a1, target.a2, target.b1, target.newAlpha, target.newSandbox])
    expectProbabilities(result, [0.3, 0.25, 0.2, 0.09, 0.005])
  })
})

describe('TypeSafe falhou ou índice ausente → ask typesafe-failed com heurística', () => {
  const recents = [recent('a1'), recent('s1'), recent('b1'), recent('a2')]
  const heuristic = [target.a1, target.s1, target.b1, target.newAlpha, target.newSandbox]

  function expectHeuristic(result: CentralRouteResult, expected = heuristic): void {
    expect(result).toEqual({ kind: 'ask', reason: 'typesafe-failed', options: expected.map((t) => ({ target: t })) })
  }

  it('1ª chamada null: até 3 recentes (mais recente primeiro), nova no projeto do último destino, sandbox; sem best', async () => {
    const { ask } = fakeAsk({ first: null })
    expectHeuristic(await decideRoute(routeRequest('x', { recent: recents }), makeIndex(), { ask }))
  })

  it('2ª chamada null: a mesma heurística', async () => {
    const { ask, calls } = fakeAsk({
      first: { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) },
      second: null
    })
    expectHeuristic(await decideRoute(routeRequest('x', { recent: recents }), makeIndex(), { ask }))
    expect(calls).toHaveLength(2)
  })

  it('índice null: não chama o TypeSafe; os alvos saem do cwd/título da tela (pasta existente)', async () => {
    const { ask, spy } = fakeAsk()
    const deps = {
      ask,
      exists: (p: string) => p !== 'C:\\sumiu',
      isSandbox: (cwd: string) => cwd.startsWith(`${SANDBOX_ROOT}\\`)
    }
    const x = recent('x', { cwd: ALPHA, title: 'Login' })
    const y = recent('y', { cwd: `${SANDBOX_ROOT}\\x9`, title: 'Dólar' })
    const xTarget = { kind: 'conversation', convId: 'x', cwd: ALPHA, project: 'alpha', title: 'Login', sandbox: false } as const
    const yTarget = { kind: 'conversation', convId: 'y', cwd: `${SANDBOX_ROOT}\\x9`, project: 'sandbox', title: 'Dólar', sandbox: true } as const

    const gone = recent('g', { cwd: 'C:\\sumiu', title: 'Sumiu' })
    expectHeuristic(await decideRoute(routeRequest('x', { recent: [x, gone, y, recent('sem-pasta')] }), null, deps), [
      xTarget,
      yTarget,
      target.newAlpha,
      target.newSandbox
    ])
    // Último destino no sandbox: nada de "nova em <projeto>".
    expectHeuristic(await decideRoute(routeRequest('x', { recent: [y, x] }), null, deps), [yTarget, xTarget, target.newSandbox])
    expect(spy).not.toHaveBeenCalled()
  })

  it('sem nenhum recente: só o sandbox novo', async () => {
    expectHeuristic(await decideRoute(routeRequest('x'), null, { ask: fakeAsk().ask }), [target.newSandbox])
  })

  it.each([
    ['continua com chave não oferecida', { continua: pick('d9', 0.99), projeto: pick('p1', 0.9) }, undefined],
    ['projeto com chave não oferecida', { continua: pick('outro_assunto', 0.9), projeto: pick('p7', 0.99) }, undefined],
    ['2ª chamada com chave não oferecida', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) }, { conversa: pick('c99', 0.99) }],
    ['2ª chamada com a chave de outra pergunta', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) }, { conversa: pick('outro_assunto', 0.99) }],
    ['resposta faltando', { projeto: pick('p1', 0.9) }, undefined],
    ['tipo errado', { continua: { ...pick('d1', 0.9), type: 'score' }, projeto: pick('p1', 0.9) }, undefined],
    ['confiança que não é número', { continua: { ...pick('d1', 0.9), confidence: 'alta' }, projeto: pick('p1', 0.9) }, undefined],
    ['sem probabilities', { continua: { type: 'choice', choice: 'd1', confidence: 0.9 }, projeto: pick('p1', 0.9) }, undefined],
    ['resposta vazia', {}, undefined]
  ])('%s → falha (heurística), nunca um destino fora da lista', async (_name, first, second) => {
    const { ask } = fakeAsk({ first, second: second ?? null })
    expectHeuristic(await decideRoute(routeRequest('x', { recent: recents }), makeIndex(), { ask }))
  })

  it('`ask` que lança conta como falha', async () => {
    const ask = async (): Promise<null> => {
      throw new Error('rede caiu')
    }
    expectHeuristic(await decideRoute(routeRequest('x', { recent: recents }), makeIndex(), { ask }))
  })

  it('fallbackRoute (TypeSafe desligado) dá a mesma heurística sem perguntar nada', () => {
    expectHeuristic(fallbackRoute(routeRequest('x', { recent: recents }), makeIndex(), {}))
  })
})

describe('forceAsk ("não era aqui" e reenvio): nunca direto, reason moved', () => {
  const confident = {
    continua: pick('d1', 0.95, { d1: 0.95, outro_assunto: 0.05 }),
    projeto: pick('p1', 0.9, { p1: 0.9, p2: 0.05, sem_projeto: 0.05 })
  }

  it('o que seria direto volta como ask, com o mesmo destino em primeiro', async () => {
    const { ask } = fakeAsk({ first: confident })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1')], forceAsk: true }), makeIndex(), { ask })
    expect(result).toMatchObject({ kind: 'ask', reason: 'moved', best: 0 })
    expect(targets(result)).toEqual([target.a1, target.newAlpha, target.newSandbox])
  })

  it('abaixo do piso ou com o TypeSafe fora: também moved', async () => {
    const low = fakeAsk({ first: { ...confident, continua: pick('d1', 0.4, { d1: 0.4, outro_assunto: 0.6 }) } })
    const lowResult = await decideRoute(routeRequest('x', { recent: [recent('a1')], forceAsk: true }), makeIndex(), { ask: low.ask })
    expect(lowResult).toMatchObject({ kind: 'ask', reason: 'moved' })

    const failed = await decideRoute(routeRequest('x', { recent: [recent('a1')], forceAsk: true }), makeIndex(), { ask: fakeAsk().ask })
    expect(failed).toEqual({
      kind: 'ask',
      reason: 'moved',
      options: [{ target: target.a1 }, { target: target.newAlpha }, { target: target.newSandbox }]
    })
  })

  it('sem nada perguntado: as opções sem probabilidade e sem best', async () => {
    const result = await decideRoute(routeRequest('x', { forceAsk: true }), makeIndex([]), { ask: fakeAsk().ask })
    expect(result).toEqual({ kind: 'ask', reason: 'moved', options: [{ target: target.newSandbox }] })
  })
})

describe('exclude: o destino tirado nunca aparece', () => {
  it('conversa excluída: fora dos recentes, dos títulos do projeto e da 2ª chamada', async () => {
    const { ask, calls } = fakeAsk({
      first: { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) },
      second: { conversa: pick('c1', 0.9) }
    })
    const req = routeRequest('x', { recent: [recent('a1'), recent('b1')], exclude: target.a1 })
    const result = await decideRoute(req, makeIndex(), { ask })

    expect(stateOf(calls[0]).recent_destinations.map((r: { conversation: string }) => r.conversation)).toEqual(['API de pagamentos'])
    expect(stateOf(calls[0]).projects[0]).toEqual({ option: 'p1', name: 'alpha', recent_conversations: ['Relatório PDF'] })
    expect(stateOf(calls[1]).conversations.map((c: { title: string }) => c.title)).toEqual(['Relatório PDF'])
    expect(JSON.stringify(calls)).not.toContain('Login torto')
    expect(result).toMatchObject({ kind: 'direct', target: target.a2, rule: 'conversa-antiga' })
  })

  it('conversa excluída nunca entra nas opções do ask', async () => {
    const { ask } = fakeAsk({
      first: {
        continua: pick('d1', 0.5, { d1: 0.5, d2: 0.3, outro_assunto: 0.2 }),
        projeto: pick('p1', 0.9, { p1: 0.9, p2: 0.05, sem_projeto: 0.05 })
      }
    })
    const req = routeRequest('x', { recent: [recent('a1'), recent('b1'), recent('a2')], exclude: target.b1 })
    const result = await decideRoute(req, makeIndex(), { ask })
    expect(result.kind).toBe('ask')
    expect(targets(result)).not.toContainEqual(target.b1)
    expect(targets(result)).toEqual([target.a1, target.a2, target.newAlpha, target.newSandbox])
  })

  it('"nova em <projeto>" excluída: o direto vira ask moved e o próximo projeto mais provável entra no lugar', async () => {
    const { ask } = fakeAsk({
      first: {
        continua: pick('outro_assunto', 0.9, { d1: 0.1, outro_assunto: 0.9 }),
        projeto: pick('p1', 0.9, { p1: 0.9, p2: 0.08, sem_projeto: 0.02 })
      },
      second: { conversa: pick('nova', 0.9, { c1: 0.05, c2: 0.05, nova: 0.9 }) }
    })
    const req = routeRequest('x', { recent: [recent('b1')], exclude: target.newAlpha })
    const result = await decideRoute(req, makeIndex(), { ask })

    expect(result).toMatchObject({ kind: 'ask', reason: 'moved', best: 0 })
    expect(targets(result)).toEqual([target.b1, target.newBeta, target.a1, target.a2, target.newSandbox])
    expectProbabilities(result, [0.1, 0.072, 0.0405, 0.0405, 0.018])
  })

  it('sandbox novo excluído: some das opções (TypeSafe e heurística)', async () => {
    const noSandboxConvs = makeIndex(SUMMARIES.filter((s) => !s.sandbox))
    const viaTypeSafe = fakeAsk({ first: { continua: pick('outro_assunto', 0.9), projeto: pick('sem_projeto', 0.9) } })
    const req = routeRequest('x', { recent: [recent('a1')], exclude: target.newSandbox })
    const direct = await decideRoute(req, noSandboxConvs, { ask: viaTypeSafe.ask })
    expect(direct).toMatchObject({ kind: 'ask', reason: 'moved' })
    expect(targets(direct)).not.toContainEqual(target.newSandbox)

    const heuristic = await decideRoute(req, noSandboxConvs, { ask: fakeAsk().ask })
    expect(targets(heuristic)).toEqual([target.a1, target.newAlpha])
  })

  it('heurística: a conversa excluída sai, mas o projeto do último destino continua oferecido', async () => {
    const req = routeRequest('x', { recent: [recent('a1'), recent('b1')], exclude: target.a1 })
    const result = await decideRoute(req, makeIndex(), { ask: fakeAsk().ask })
    expect(targets(result)).toEqual([target.b1, target.newAlpha, target.newSandbox])
  })

  it('exclude sem forceAsk não impede um direto para OUTRO destino', async () => {
    const { ask } = fakeAsk({ first: { continua: pick('d1', 0.9), projeto: pick('p1', 0.9) } })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1')], exclude: target.b1 }), makeIndex(), { ask })
    expect(result).toMatchObject({ kind: 'direct', target: target.a1 })
  })
})

describe('forma das opções', () => {
  it('cada opção do TypeSafe traz a probabilidade; best aponta a mais provável', async () => {
    const { ask } = fakeAsk({
      first: {
        continua: pick('d2', 0.45, { d1: 0.15, d2: 0.45, outro_assunto: 0.4 }),
        projeto: pick('p1', 0.9, { p1: 0.9, p2: 0.05, sem_projeto: 0.05 })
      }
    })
    const result = await decideRoute(routeRequest('x', { recent: [recent('a1'), recent('b1')] }), makeIndex(), { ask })
    if (result.kind !== 'ask') throw new Error('esperava ask')
    const options: CentralOption[] = result.options
    expect(options.every((o) => typeof o.probability === 'number')).toBe(true)
    const top = Math.max(...options.map((o) => o.probability ?? 0))
    expect(options[result.best!].probability).toBe(top)
    expect(options[result.best!].target).toEqual(target.b1)
  })
})
