// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CENTRAL_MIN_CONFIDENCE, decideRoute } from './centralDecider'
import {
  ALPHA,
  BETA,
  SANDBOX_ROOT,
  SUMMARIES,
  fakeAsk,
  makeIndex,
  optionsOf,
  pick,
  recent,
  routeRequest,
  stateOf,
  target
} from './centralDeciderKit'
import { CENTRAL_STATE_BUDGET_TOKENS, estimateTokens } from './centralIndex'
import { centralPromptTexts } from './centralPrompts'
import { sum } from './centralTestKit'

// Pedido/estado de cada chamada e as regras 1–3 com confiança alta.
// Abaixo do piso, falhas, forceAsk e exclude: centralDecider.ask.test.ts.

const alwaysExists = (): boolean => true

describe('decideRoute — 1ª chamada (o leque)', () => {
  it('state: a mensagem com os nomes dos anexos, só os recentes válidos e os projetos sem o sandbox', async () => {
    const { ask, calls } = fakeAsk({ first: { continua: pick('d1', 0.9), projeto: pick('p1', 0.9) } })
    const req = routeRequest('o botão ficou torto', {
      attachments: ['print.png', 'log.txt'],
      recent: [
        recent('a1'),
        recent('sumiu', { cwd: 'C:\\nao\\existe', title: 'Pasta apagada' }),
        recent('sem-pasta'),
        recent('central', { cwd: ALPHA, title: 'Central' }),
        recent('nova', { cwd: ALPHA, title: 'Conversa recém-criada' })
      ]
    })

    await decideRoute(req, makeIndex(), { ask, exists: (p) => p === ALPHA })

    expect(calls).toHaveLength(1)
    const state = stateOf(calls[0])
    expect(state.message).toEqual({ text: 'o botão ficou torto', attachments: ['print.png', 'log.txt'] })
    expect(state.recent_destinations).toEqual([
      { option: 'd1', project: 'alpha', conversation: 'Login torto', last_request: 'pedido a1', reply_start: 'resposta a1' },
      { option: 'd2', project: 'alpha', conversation: 'Conversa recém-criada', last_request: 'pedido nova', reply_start: 'resposta nova' }
    ])
    expect(state.projects).toEqual([
      { option: 'p1', name: 'alpha', recent_conversations: ['Login torto', 'Relatório PDF'] },
      { option: 'p2', name: 'beta', recent_conversations: ['API de pagamentos'] }
    ])
    expect(JSON.stringify(state)).not.toContain('Cotação do dólar')
    expect(optionsOf(calls[0], 'continua')).toEqual(['d1', 'd2', 'outro_assunto'])
    expect(optionsOf(calls[0], 'projeto')).toEqual(['p1', 'p2', 'sem_projeto'])
    expect(Object.keys(calls[0].questions).sort()).toEqual(['continua', 'projeto'])
  })

  it('descrições ao lado das chaves: "projeto · conversa", o nome do projeto e as opções fixas', async () => {
    const { ask, calls } = fakeAsk({ first: { continua: pick('d1', 0.9), projeto: pick('p1', 0.9) } })
    await decideRoute(routeRequest('oi', { recent: [recent('a1'), recent('s1')] }), makeIndex(), { ask })
    const texts = centralPromptTexts('en')
    const continua = calls[0].questions.continua
    const projeto = calls[0].questions.projeto
    expect(continua).toMatchObject({
      type: 'choice',
      instructions: texts.continua,
      criteria: { d1: 'alpha · Login torto', d2: 'sandbox · Cotação do dólar', outro_assunto: texts.otherSubject }
    })
    expect(projeto).toMatchObject({
      type: 'choice',
      instructions: texts.projeto,
      criteria: { p1: 'alpha', p2: 'beta', sem_projeto: texts.noProject }
    })
  })

  it('sem recente válido não pergunta `continua`; sem projeto não pergunta `projeto`', async () => {
    const onlyProjects = fakeAsk({ first: { projeto: pick('sem_projeto', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('oi'), makeIndex(), { ask: onlyProjects.ask })
    expect(Object.keys(onlyProjects.calls[0].questions)).toEqual(['projeto'])

    const onlyRecents = fakeAsk({ first: { continua: pick('d1', 0.9) } })
    const sandboxOnly = makeIndex(SUMMARIES.filter((s) => s.sandbox))
    await decideRoute(routeRequest('oi', { recent: [recent('s1')] }), sandboxOnly, { ask: onlyRecents.ask })
    expect(Object.keys(onlyRecents.calls[0].questions)).toEqual(['continua'])
  })

  it('o idioma escolhe as instruções (padrão: inglês)', async () => {
    const en = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('oi'), makeIndex(), { ask: en.ask })
    expect(en.calls[0].questions.projeto).toMatchObject({ instructions: centralPromptTexts('en').projeto })
    expect(en.calls[1].questions.conversa).toMatchObject({ instructions: centralPromptTexts('en').conversation })

    const pt = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('oi'), makeIndex(), { ask: pt.ask, lang: 'pt' })
    expect(pt.calls[0].questions.projeto).toMatchObject({ instructions: centralPromptTexts('pt').projeto })
    expect(pt.calls[1].questions.conversa).toMatchObject({ instructions: centralPromptTexts('pt').conversation })
  })

  it('segredos viram [segredo] em todo texto que vai ao TypeSafe (mensagem, recentes, resumos, títulos)', async () => {
    const key = ['sk', 'proj', 'Zz99Yy88Xx77Ww66Vv55Uu44'].join('-')
    const index = makeIndex([
      sum('a1', { title: `deploy com ${key}`, firstRequest: 'senha: Abacaxi#2024', updatedAt: 50 }),
      ...SUMMARIES.slice(1)
    ])
    const { ask, calls } = fakeAsk({
      first: { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) },
      second: { conversa: pick('nova', 0.9) }
    })
    const req = routeRequest(`usa a password=hunter22 e ${key}`, {
      attachments: [`${key}.txt`],
      recent: [recent('a1', { request: `token=${key}`, replyStart: 'Bearer abcDEF123ghiJKL456mnoPQR' })]
    })

    await decideRoute(req, index, { ask })

    const sent = JSON.stringify(calls)
    expect(calls).toHaveLength(2)
    for (const secret of [key, 'hunter22', 'Abacaxi#2024', 'abcDEF123ghiJKL456mnoPQR']) expect(sent).not.toContain(secret)
    expect(sent).toContain('[segredo]')
  })
})

describe('decideRoute — regras com confiança alta', () => {
  it('regra 1: `continua` aponta um destino recente → direto, regra continua', async () => {
    const { ask, calls } = fakeAsk({ first: { continua: pick('d2', 0.9), projeto: pick('p2', 0.95) } })
    const result = await decideRoute(routeRequest('e o euro?', { recent: [recent('a1'), recent('s1')] }), makeIndex(), { ask })
    expect(result).toEqual({ kind: 'direct', target: target.s1, rule: 'continua', confidence: 0.9, why: 'continua “Cotação do dólar”' })
    expect(calls).toHaveLength(1)
  })

  it('regra 1 com um destino que o índice ainda não tem: o alvo sai do cwd/título que a tela mandou', async () => {
    const { ask } = fakeAsk({ first: { continua: pick('d1', 0.8), projeto: pick('p1', 0.8) } })
    const req = routeRequest('continua', { recent: [recent('fresca', { cwd: BETA, title: 'Webhook novo' })] })
    const result = await decideRoute(req, makeIndex(), { ask, exists: alwaysExists })
    expect(result).toMatchObject({
      kind: 'direct',
      rule: 'continua',
      target: { kind: 'conversation', convId: 'fresca', cwd: BETA, project: 'beta', title: 'Webhook novo', sandbox: false }
    })
  })

  it('regra 2: projeto + 2ª chamada só com as conversas dele → retoma a conversa antiga', async () => {
    const { ask, calls } = fakeAsk({
      first: { continua: pick('outro_assunto', 0.8), projeto: pick('p1', 0.9) },
      second: { conversa: pick('c2', 0.7) }
    })
    const result = await decideRoute(routeRequest('o pdf saiu cortado', { recent: [recent('b1')] }), makeIndex(), { ask })

    expect(result).toEqual({ kind: 'direct', target: target.a2, rule: 'conversa-antiga', confidence: 0.7, why: 'retoma “Relatório PDF”' })
    expect(calls).toHaveLength(2)
    const state = stateOf(calls[1])
    expect(state.message).toEqual({ text: 'o pdf saiu cortado', attachments: [] })
    expect(state.project).toBe('alpha')
    expect(state.conversations).toEqual([
      { option: 'c1', title: 'Login torto', first_request: 'arruma o login', last_requests: [], files: ['src/login.tsx'], answer_start: '' },
      { option: 'c2', title: 'Relatório PDF', first_request: 'gera o pdf', last_requests: [], files: [], answer_start: '' }
    ])
    expect(optionsOf(calls[1], 'conversa')).toEqual(['c1', 'c2', 'nova'])
    expect(calls[1].questions.conversa).toMatchObject({
      criteria: { c1: 'Login torto', c2: 'Relatório PDF', nova: centralPromptTexts('en').newConversation }
    })
  })

  it('regra 3: `nova` na 2ª chamada → conversa nova na pasta do projeto', async () => {
    const { ask } = fakeAsk({ first: { projeto: pick('p2', 0.85) }, second: { conversa: pick('nova', 0.95) } })
    const result = await decideRoute(routeRequest('cria um endpoint de estorno'), makeIndex(), { ask })
    expect(result).toEqual({ kind: 'direct', target: target.newBeta, rule: 'nova', confidence: 0.85, why: 'assunto novo em beta' })
  })

  it('regra 4: `sem_projeto` → 2ª chamada entre as conversas do SANDBOX; a existente vence', async () => {
    const { ask, calls } = fakeAsk({ first: { projeto: pick('sem_projeto', 0.9) }, second: { conversa: pick('c1', 0.8) } })
    const result = await decideRoute(routeRequest('e o euro?'), makeIndex(), { ask })

    expect(result).toEqual({
      kind: 'direct',
      target: target.s1,
      rule: 'sandbox',
      confidence: 0.8,
      why: 'continua “Cotação do dólar” no sandbox'
    })
    expect(stateOf(calls[1]).project).toBe('sandbox')
    expect(stateOf(calls[1]).conversations.map((c: { title: string }) => c.title)).toEqual(['Cotação do dólar'])
    expect(calls[1].questions.conversa).toMatchObject({
      instructions: centralPromptTexts('en').sandbox,
      criteria: { c1: 'Cotação do dólar', nova: centralPromptTexts('en').newSandbox }
    })
  })

  it('regra 4: `nova` no sandbox → sandbox novo', async () => {
    const { ask } = fakeAsk({ first: { projeto: pick('sem_projeto', 0.9) }, second: { conversa: pick('nova', 0.7) } })
    const result = await decideRoute(routeRequest('quanto é 2+2?'), makeIndex(), { ask })
    expect(result).toEqual({ kind: 'direct', target: target.newSandbox, rule: 'sandbox', confidence: 0.7, why: 'sem projeto' })
  })

  it('regra 4 sem nenhuma conversa de sandbox: sandbox novo direto, sem 2ª chamada', async () => {
    const { ask, calls } = fakeAsk({ first: { continua: pick('outro_assunto', 0.95), projeto: pick('sem_projeto', 0.75) } })
    const index = makeIndex(SUMMARIES.filter((s) => !s.sandbox))
    const result = await decideRoute(routeRequest('quanto tá o dólar?', { recent: [recent('a1')] }), index, { ask })
    expect(result).toEqual({ kind: 'direct', target: target.newSandbox, rule: 'sandbox', confidence: 0.75, why: 'sem projeto' })
    expect(calls).toHaveLength(1)
  })

  it('índice vazio e nenhum recente: nada a perguntar, sandbox novo', async () => {
    const { ask, spy } = fakeAsk()
    const result = await decideRoute(routeRequest('oi'), makeIndex([]), { ask })
    expect(result).toEqual({ kind: 'direct', target: target.newSandbox, rule: 'sandbox', confidence: 1, why: 'sem projeto' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('sem projetos mas com conversas de sandbox: vai direto à 2ª chamada do sandbox', async () => {
    const { ask, calls } = fakeAsk({ second: { conversa: pick('c1', 0.9) } })
    const index = makeIndex(SUMMARIES.filter((s) => s.sandbox))
    const result = await decideRoute(routeRequest('e o euro?'), index, { ask })
    expect(result).toMatchObject({ kind: 'direct', target: target.s1, rule: 'sandbox' })
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0].questions)).toEqual(['conversa'])
  })
})

describe('decideRoute — o piso de confiança', () => {
  it('o piso padrão é 0,6, próprio da Central', () => {
    expect(CENTRAL_MIN_CONFIDENCE).toBe(0.6)
  })

  it.each([
    ['continua', { continua: pick('d1', 0.6), projeto: pick('p1', 0.9) }, undefined, 'direct'],
    ['continua', { continua: pick('d1', 0.5999), projeto: pick('p1', 0.9) }, undefined, 'ask'],
    ['projeto', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.6) }, { conversa: pick('c1', 0.9) }, 'direct'],
    ['projeto', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.5999) }, { conversa: pick('c1', 0.9) }, 'ask'],
    ['2ª chamada', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) }, { conversa: pick('c1', 0.6) }, 'direct'],
    ['2ª chamada', { continua: pick('outro_assunto', 0.9), projeto: pick('p1', 0.9) }, { conversa: pick('c1', 0.5999) }, 'ask']
  ])('%s: %o → %s', async (_step, first, second, kind) => {
    const { ask } = fakeAsk({ first, second: second ?? null })
    const result = await decideRoute(routeRequest('x', { recent: [recent('b1')] }), makeIndex(), { ask })
    expect(result.kind).toBe(kind)
    if (result.kind === 'ask') expect(result.reason).toBe('low-confidence')
  })

  it('`floor` injetado substitui o padrão', async () => {
    const { ask } = fakeAsk({ first: { continua: pick('d1', 0.7), projeto: pick('p1', 0.9) } })
    const req = routeRequest('x', { recent: [recent('a1')] })
    expect((await decideRoute(req, makeIndex(), { ask })).kind).toBe('direct')
    expect((await decideRoute(req, makeIndex(), { ask, floor: 0.8 })).kind).toBe('ask')
  })

  it('a confiança do direto é a menor dos passos que levaram a ele', async () => {
    const { ask } = fakeAsk({
      first: { continua: pick('outro_assunto', 0.65), projeto: pick('p1', 0.9) },
      second: { conversa: pick('c1', 0.95) }
    })
    const result = await decideRoute(routeRequest('x', { recent: [recent('b1')] }), makeIndex(), { ask })
    expect(result).toMatchObject({ kind: 'direct', target: target.a1, confidence: 0.65 })
  })
})

describe('decideRoute — corte pelo orçamento', () => {
  /** `count` projetos (proj-0 o mais recente), cada um com `perProject` conversas de título com `titleChars` caracteres. */
  const manyProjects = (count: number, titleChars: number, perProject = 1) =>
    Array.from({ length: count }, (_, i) =>
      Array.from({ length: perProject }, (_, j) =>
        sum(`p${i}-${j}`, {
          cwd: `C:\\work\\proj-${i}`,
          project: `proj-${i}`,
          title: `${i}.${j} `.padEnd(titleChars, 'x'),
          updatedAt: 100_000 - i * 10 - j
        })
      )
    ).flat()

  it('no máximo 254 projetos (+ sem_projeto = 255 opções), os mais recentes', async () => {
    const { ask, calls } = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('x'), makeIndex(manyProjects(300, 5)), { ask })
    const options = optionsOf(calls[0], 'projeto')
    expect(options).toHaveLength(255)
    expect(options.at(-1)).toBe('sem_projeto')
    expect(stateOf(calls[0]).projects[0].name).toBe('proj-0')
    expect(stateOf(calls[0]).projects).toHaveLength(254)
  })

  it('o state inteiro cabe em ~24k tokens: com títulos longos entram menos projetos, sempre os mais recentes', async () => {
    const { ask, calls } = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    const long = 'Mensagem longa '.repeat(1_000)
    await decideRoute(routeRequest(long), makeIndex(manyProjects(250, 199, 5)), { ask })
    const state = stateOf(calls[0])
    expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(CENTRAL_STATE_BUDGET_TOKENS)
    expect(state.projects.length).toBeGreaterThan(10)
    expect(state.projects.length).toBeLessThan(250)
    expect(state.projects.map((p: { name: string }) => p.name)).toEqual(
      Array.from({ length: state.projects.length }, (_, i) => `proj-${i}`)
    )
    expect(optionsOf(calls[0], 'projeto')).toHaveLength(state.projects.length + 1)
  })

  it('2ª chamada: no máximo 254 conversas do projeto (+ nova), as mais recentes, dentro do orçamento', async () => {
    const convs = Array.from({ length: 300 }, (_, i) => sum(`c${i}`, { title: `conversa ${i}`, updatedAt: 10_000 - i }))
    const { ask, calls } = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('x'), makeIndex(convs), { ask })
    const options = optionsOf(calls[1], 'conversa')
    expect(options).toHaveLength(255)
    expect(options.at(-1)).toBe('nova')
    expect(stateOf(calls[1]).conversations[0].title).toBe('conversa 0')
    expect(estimateTokens(JSON.stringify(stateOf(calls[1])))).toBeLessThanOrEqual(CENTRAL_STATE_BUDGET_TOKENS)
  })

  it('2ª chamada: com mensagem longa e resumos grandes, o orçamento corta (mensagem incluída na conta)', async () => {
    const convs = Array.from({ length: 200 }, (_, i) =>
      sum(`c${i}`, { title: `${i} `.padEnd(199, 't'), firstRequest: 'r'.repeat(199), answerStart: 'a'.repeat(199), updatedAt: 10_000 - i })
    )
    const { ask, calls } = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    await decideRoute(routeRequest('Mensagem longa '.repeat(1_000)), makeIndex(convs), { ask })
    const state = stateOf(calls[1])
    expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(CENTRAL_STATE_BUDGET_TOKENS)
    expect(state.conversations.length).toBeGreaterThan(10)
    expect(state.conversations.length).toBeLessThan(200)
    expect(optionsOf(calls[1], 'conversa')).toHaveLength(state.conversations.length + 1)
  })

  it('no máximo 5 destinos recentes, os primeiros da lista', async () => {
    const convs = Array.from({ length: 7 }, (_, i) => sum(`r${i}`, { title: `recente ${i}`, updatedAt: 100 - i }))
    const { ask, calls } = fakeAsk({ first: { continua: pick('d1', 0.9), projeto: pick('p1', 0.9) } })
    await decideRoute(routeRequest('x', { recent: convs.map((c) => recent(c.convId)) }), makeIndex(convs), { ask })
    expect(stateOf(calls[0]).recent_destinations.map((r: { conversation: string }) => r.conversation)).toEqual(
      ['recente 0', 'recente 1', 'recente 2', 'recente 3', 'recente 4']
    )
    expect(optionsOf(calls[0], 'continua')).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'outro_assunto'])
  })

  it('projeto ou conversa cortados pelo orçamento não são aceitos como resposta', async () => {
    const projects = manyProjects(300, 5)
    const lateProject = fakeAsk({ first: { projeto: pick('p256', 0.99) }, second: { conversa: pick('nova', 0.99) } })
    expect(await decideRoute(routeRequest('x'), makeIndex(projects), { ask: lateProject.ask })).toMatchObject({
      kind: 'ask',
      reason: 'typesafe-failed'
    })

    const convs = Array.from({ length: 300 }, (_, i) => sum(`c${i}`, { title: `conversa ${i}`, updatedAt: 10_000 - i }))
    const lateConversation = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('c256', 0.99) } })
    expect(await decideRoute(routeRequest('x'), makeIndex(convs), { ask: lateConversation.ask })).toMatchObject({
      kind: 'ask',
      reason: 'typesafe-failed'
    })
  })

  it('a pasta do sandbox não vira projeto mesmo quando é o grupo mais recente', async () => {
    const { ask, calls } = fakeAsk({ first: { projeto: pick('p1', 0.9) }, second: { conversa: pick('nova', 0.9) } })
    const index = makeIndex([...SUMMARIES, sum('s9', { cwd: `${SANDBOX_ROOT}\\x9`, project: 'sandbox', sandbox: true, updatedAt: 999 })])
    await decideRoute(routeRequest('x'), index, { ask })
    expect(stateOf(calls[0]).projects.map((p: { name: string }) => p.name)).toEqual(['alpha', 'beta'])
  })
})
