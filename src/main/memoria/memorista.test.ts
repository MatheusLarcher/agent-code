// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MEMORISTA_AUTO_MODELS } from '../../shared/ipc'
import type { ChatEvent, MemoristaConfig, MemoristaProviderDiagnostic } from '../../shared/ipc'
import type { MemoryProposeInput } from '../memory/memoryModel'
import type { MemoryEntry } from '../persistence/types'
import type { MemoryGateInput } from '../typesafe'

/** Só a decisão automática é dublada; o resto da pasta typesafe segue real —
 *  é o caminho SEM `deps.autoModel`, o de produção, que precisa ser visto. */
const chooseAutoExecution = vi.fn(async () => ({
  model: 'claude-sonnet-5',
  effort: 'low' as const,
  source: 'typesafe' as const
}))
vi.mock('../typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../typesafe')>()),
  chooseAutoExecution: (...args: unknown[]) => chooseAutoExecution(...(args as []))
}))

import { Memorista, type MemoristaMemoryPort, type MemoristaObserverRequest } from './memorista'
import { MEMORISTA_COOLDOWN_MS, MEMORISTA_MAX_CALLS, MEMORISTA_MAX_USER_CHARS } from './memoristaPrompt'

const config = (over: Partial<MemoristaConfig> = {}): MemoristaConfig => ({
  enabled: true,
  model: 'claude-sonnet-5',
  ...over
})

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem-1',
    relPath: 'fiscal/nota.md',
    title: 'Nota de serviço',
    hook: 'ao emitir nota',
    scope: 'user',
    projectCwd: null,
    domain: null,
    body: '# Nota de serviço\nO município retém 2% de ISS.',
    bodyHash: 'hash',
    revision: 7,
    status: 'active',
    originConversationId: null,
    originMessageId: null,
    originAgent: null,
    supersedesId: null,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

/** O dublê do acervo: devolve cópias a cada `listEntries`, como o serviço real. */
function fakeMemory(initial: MemoryEntry[] = []) {
  const entries = [...initial]
  return {
    listEntries: vi.fn(async () => entries.map((item) => ({ ...item }))),
    propose: vi.fn(async (input: MemoryProposeInput) => ({ id: `prop-${input.relPath}` })),
    applyPending: vi.fn(async () => ({ applied: 1 }))
  } as unknown as MemoristaMemoryPort & {
    listEntries: ReturnType<typeof vi.fn>
    propose: ReturnType<typeof vi.fn>
    applyPending: ReturnType<typeof vi.fn>
  }
}

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const failure: ChatEvent = { kind: 'error', id: 'e', text: 'a sessão caiu' }
const toolUse = (name: string, input: unknown): ChatEvent => ({
  kind: 'tool-use',
  id: `t-${name}`,
  name,
  input,
  parentToolUseId: null
})

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function proposals(memory: ReturnType<typeof fakeMemory>): MemoryProposeInput[] {
  return memory.propose.mock.calls.map((call) => call[0] as MemoryProposeInput)
}

/** Um `ask` com a assinatura real (prompt, model) — é o que permite ao teste
 *  inspecionar o digest que o memorista montou. */
const answer = (text: string) => vi.fn(async (_prompt: string, _model: string) => text)

/** Só o trecho do digest com a fala do usuário: é ali que a fila aparece. */
function userSection(prompt: string): string {
  return prompt.split('O QUE O USUÁRIO DISSE NESTE TURNO:')[1]?.split('AÇÕES DESTE TURNO:')[0] ?? ''
}

/** Só o trecho das ações, para conferir o teto de chamadas do acumulado. */
function callLines(prompt: string): string[] {
  const section = prompt.split('AÇÕES DESTE TURNO:')[1] ?? ''
  return section.split('\n').filter((line) => line.startsWith('- '))
}

describe('Memorista — a régua do usuário (não só correção)', () => {
  it('instrução de como trabalhar vira memória nova pelo serviço', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(
      async () =>
        'NOVA | instrucao | migracao-em-producao.md | Migração em produção | ao mexer no banco | Nunca rodar migração direto em produção.'
    )
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'nunca rode migração direto em produção')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(proposals(memory)).toHaveLength(1)
    const [proposal] = proposals(memory)
    expect(proposal.op).toBe('create')
    expect(proposal.relPath).toBe('migracao-em-producao.md')
    expect(proposal.body).toContain('Nunca rodar migração direto em produção.')
    expect(proposal.originAgent).toBe('memorista')
    expect(memory.applyPending).toHaveBeenCalledTimes(1)
  })

  it('conhecimento de domínio informado pelo usuário vira memória', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(
      async () =>
        'NOVA | conhecimento | iss-retido.md | ISS retido | ao emitir nota de serviço | A prefeitura retém 5% de ISS acima de R$ 5.000.'
    )
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'aqui a prefeitura retém 5% de ISS acima de 5 mil')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(proposals(memory)[0]?.body).toContain('type: conhecimento')
  })

  it('preferência do usuário vira memória', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(
      async () =>
        'NOVA | preferencia | estilo-de-resposta.md | Resposta curta | ao responder | O usuário prefere resposta direta, sem introdução.'
    )
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'responda direto, sem enrolação')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(proposals(memory)[0]?.body).toContain('type: preferencia')
  })

  it('fato já evidente do código não vira memória: o modelo cala e nada é escrito', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(async () => 'OK')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'o build roda com npm run dev, está no package.json')
    memorista.observe('conv-1', toolUse('Read', { file_path: 'C:/p/package.json' }))
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(memory.propose).not.toHaveBeenCalled()
    expect(memory.applyPending).not.toHaveBeenCalled()
  })
})

describe('Memorista — escrita', () => {
  it('assunto que já existe no índice vira UPDATE com a revisão fresca, não um arquivo novo', async () => {
    const memory = fakeMemory([entry()])
    const ask = vi.fn(async () => 'COMPLEMENTA | fiscal/nota.md | A retenção subiu para 5% em 2026.')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'a retenção subiu para 5% neste ano')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    const [proposal] = proposals(memory)
    expect(proposal.op).toBe('update')
    expect(proposal.expectedRevision).toBe(7)
    // Acrescenta sem apagar o que já estava no arquivo.
    expect(proposal.body).toContain('O município retém 2% de ISS.')
    expect(proposal.body).toContain('A retenção subiu para 5% em 2026.')
  })

  it('o índice vai no digest, para o modelo poder dizer "isso já está salvo"', async () => {
    const memory = fakeMemory([entry()])
    const ask = answer('OK')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'sobre a nota de serviço…')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(String(ask.mock.calls[0][0])).toContain('fiscal/nota.md — Nota de serviço: ao emitir nota')
  })

  it('arquivo criado durante a consulta ao modelo barra o create: falha fechada', async () => {
    const memory = fakeMemory()
    // A primeira leitura (digest) vê o acervo vazio; a segunda, feita logo antes
    // de escrever, já vê o arquivo — foi o curador, ou o usuário, no meio disso.
    memory.listEntries.mockImplementationOnce(async () => []).mockImplementationOnce(async () => [entry({ relPath: 'iss-retido.md' })])
    const ask = vi.fn(async () => 'NOVA | conhecimento | iss-retido.md | ISS retido | ao emitir nota | A prefeitura retém 5%.')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'a prefeitura retém 5%')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(memory.propose).not.toHaveBeenCalled()
  })

  it('credencial citada no fato vai para o cofre, nunca para o corpo', async () => {
    const memory = fakeMemory()
    const put = vi.fn(async () => ({}))
    const ask = vi.fn(
      async () =>
        'NOVA | infra | token-do-deploy.md | Token do deploy | ao publicar | O token do deploy é sk-ant-api03-SEGREDOSUPERLONGOPARADETECCAO1234567890.'
    )
    const sanitize = vi.fn(async (input: MemoryProposeInput) => ({
      input: { ...input, body: String(input.body).replace(/sk-ant-\S+/, '{{secret:token}}') },
      stored: ['token'],
      skipped: [],
      notes: []
    }))
    const memorista = new Memorista({
      config,
      memory: () => memory,
      vault: () => ({ enabled: () => true, put }),
      sanitize: sanitize as never,
      ask
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'o token do deploy fica no cofre')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(sanitize).toHaveBeenCalled()
    expect(proposals(memory)[0]?.body).toContain('{{secret:token}}')
    expect(proposals(memory)[0]?.body).not.toContain('sk-ant-api03')
  })
})

describe('Memorista — gatilho, cooldown e silêncio', () => {
  it('turno que morreu em erro não é analisado', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(async () => 'NOVA | instrucao | x.md | X | quando | fato')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'me ensina uma coisa')
    memorista.observe('conv-1', failure)
    memorista.observe('conv-1', result)
    await flush()

    expect(ask).not.toHaveBeenCalled()
    expect(memory.propose).not.toHaveBeenCalled()
  })

  it('cooldown pula a análise, e o turno pulado volta no digest da seguinte', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    memorista.noteUserMessage('conv-1', 'C:/p', 'primeiro: sempre use pnpm neste projeto')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')
    expect(ask).toHaveBeenCalledTimes(1)

    // Dentro do cooldown: não consulta o modelo, mas guarda o turno.
    now += 1_000
    memorista.noteUserMessage('conv-1', 'C:/p', 'segundo: o servidor de homologação cai às sextas')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')
    expect(ask).toHaveBeenCalledTimes(1)

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'terceiro: e o deploy é manual')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(2)
    const digest = String(ask.mock.calls[1][0])
    // O turno pulado não se perdeu: ele entra numerado junto com o de agora.
    expect(digest).toContain('o servidor de homologação cai às sextas')
    expect(digest).toContain('e o deploy é manual')
  })

  it('análise que não chega ao fim devolve o turno pulado para a fila', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    memorista.noteUserMessage('conv-1', 'C:/p', 'primeiro turno')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    now += 1_000
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno pulado pelo cooldown')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    // O modelo cai bem na análise que já tinha TIRADO o turno pulado da fila:
    // sem devolver, esse turno nunca mais seria lido por ninguém.
    now += MEMORISTA_COOLDOWN_MS
    ask.mockRejectedValueOnce(new Error('modelo fora do ar'))
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'quarto turno')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    const digest = String(ask.mock.calls.at(-1)?.[0])
    expect(digest).toContain('turno pulado pelo cooldown')
  })

  it('desligado nas configurações não consulta o modelo nem escreve', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(async () => 'NOVA | instrucao | x.md | X | quando | fato')
    const memorista = new Memorista({ config: () => config({ enabled: false }), memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'sempre use pnpm')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(ask).not.toHaveBeenCalled()
    expect(memory.listEntries).not.toHaveBeenCalled()
  })

  it('sem serviço de memória nem consulta o modelo: seria gastar a chamada à toa', async () => {
    const ask = vi.fn(async () => 'OK')
    const memorista = new Memorista({ config, memory: () => null, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'sempre use pnpm')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(ask).not.toHaveBeenCalled()
  })
})

/**
 * O memorista é a ÚNICA análise do turno: não há rodada de abertura atrás dele,
 * como no PO. Uma análise que não completou não é um turno "já visto" — é um
 * turno que ninguém leu, e ele tem que voltar para a fila.
 */
describe('Memorista — turno cuja análise falhou volta para a fila', () => {
  it('modelo fora do ar devolve o turno: ele entra no digest da análise seguinte', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    ask.mockRejectedValueOnce(new Error('modelo fora do ar'))
    memorista.noteUserMessage('conv-1', 'C:/p', 'o deploy de produção é sempre manual')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    const digest = userSection(String(ask.mock.calls.at(-1)?.[0]))
    expect(digest).toContain('o deploy de produção é sempre manual')
    expect(digest).toContain('turno seguinte')
  })

  it('Claude indisponível com a Luna fora devolve o turno', async () => {
    const memory = fakeMemory()
    const prompts: string[] = []
    let lunaUp = false
    let now = 1_000_000
    const memorista = new Memorista({
      config,
      memory: () => memory,
      now: () => now,
      runClaude: async (request: MemoristaObserverRequest) => {
        prompts.push(request.prompt)
        return { provider: 'claude', state: 'failed', reason: 'claude_plan' }
      },
      runLuna: async (_request: MemoristaObserverRequest, onStarted: () => void) => {
        if (!lunaUp) return { provider: 'gpt-luna', state: 'not-started' }
        onStarted()
        return { provider: 'gpt-luna', state: 'completed', text: 'OK' }
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'a homologação exige VPN')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    lunaUp = true
    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(userSection(prompts.at(-1) ?? '')).toContain('a homologação exige VPN')
  })

  it('serviço de memória lançando devolve o turno', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    memory.listEntries.mockRejectedValueOnce(new Error('banco offline'))
    memorista.noteUserMessage('conv-1', 'C:/p', 'o ISS daqui é retido na fonte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')
    expect(ask).not.toHaveBeenCalled()

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(userSection(String(ask.mock.calls.at(-1)?.[0]))).toContain('o ISS daqui é retido na fonte')
  })

  it('serviço de memória offline devolve o turno', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let offline = true
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => (offline ? null : memory), ask, now: () => now })

    memorista.noteUserMessage('conv-1', 'C:/p', 'o cliente só aceita nota até o dia 5')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    offline = false
    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(userSection(String(ask.mock.calls.at(-1)?.[0]))).toContain('o cliente só aceita nota até o dia 5')
  })

  it('análise que rodou e não achou nada a guardar NÃO devolve o turno', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    memorista.noteUserMessage('conv-1', 'C:/p', 'bom dia, tudo certo por aqui')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno seguinte')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    // Esse turno foi LIDO. Repeti-lo seria gastar a chamada seguinte com uma
    // pergunta já respondida.
    expect(userSection(String(ask.mock.calls.at(-1)?.[0]))).not.toContain('bom dia, tudo certo por aqui')
  })

  it('falhas em sequência não fazem a fila crescer sem limite', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    for (let turn = 1; turn <= 12; turn++) {
      ask.mockRejectedValueOnce(new Error('modelo fora do ar'))
      now += MEMORISTA_COOLDOWN_MS
      memorista.noteUserMessage('conv-1', 'C:/p', `turno ${turn}: ${'x'.repeat(1000)}`)
      memorista.observe('conv-1', toolUse('Read', { file_path: `C:/p/a-${turn}.ts` }))
      memorista.observe('conv-1', toolUse('Edit', { file_path: `C:/p/b-${turn}.ts` }))
      memorista.observe('conv-1', toolUse('Bash', { command: `echo ${turn}` }))
      memorista.observe('conv-1', result)
      await memorista.settled('conv-1')
    }

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno final')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    const digest = String(ask.mock.calls.at(-1)?.[0])
    // O que ficou é a cauda recente, dentro do mesmo teto do digest de sempre.
    expect(userSection(digest)).toContain('turno final')
    expect(userSection(digest)).toContain('turno 12:')
    expect(userSection(digest)).not.toContain('turno 1:')
    expect(userSection(digest).length).toBeLessThanOrEqual(MEMORISTA_MAX_USER_CHARS + 'O QUE O USUÁRIO DISSE NESTE TURNO:'.length)
    expect(callLines(digest).length).toBeLessThanOrEqual(MEMORISTA_MAX_CALLS)
  })

  it('o turno devolvido é enfileirado uma vez só', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now })

    ask.mockRejectedValueOnce(new Error('modelo fora do ar'))
    memorista.noteUserMessage('conv-1', 'C:/p', 'marcador-unico')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    // Dentro do cooldown: este turno só é adiado, não reanalisa o anterior.
    now += 1_000
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno adiado')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'turno final')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    const digest = userSection(String(ask.mock.calls.at(-1)?.[0]))
    expect(digest.match(/marcador-unico/g)).toHaveLength(1)
    // E na ordem em que aconteceram.
    expect(digest.indexOf('marcador-unico')).toBeLessThan(digest.indexOf('turno adiado'))
    expect(digest.indexOf('turno adiado')).toBeLessThan(digest.indexOf('turno final'))
  })
})

describe('Memorista — nunca derruba o turno observado', () => {
  it('serviço de memória rejeitando não lança para fora do módulo', async () => {
    const memory = fakeMemory()
    memory.propose.mockRejectedValue(new Error('proposta recusada'))
    memory.applyPending.mockRejectedValue(new Error('drain falhou'))
    const ask = vi.fn(async () => 'NOVA | instrucao | pnpm.md | pnpm | ao instalar | Use pnpm neste projeto.')
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    expect(() => memorista.observe('conv-1', result)).not.toThrow()
    await expect(memorista.settled('conv-1')).resolves.toBeUndefined()
  })

  it('consulta ao modelo rejeitando não lança e não escreve nada', async () => {
    const memory = fakeMemory()
    const ask = vi.fn(async () => {
      throw new Error('modelo fora do ar')
    })
    const memorista = new Memorista({ config, memory: () => memory, ask })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', result)
    await expect(memorista.settled('conv-1')).resolves.toBeUndefined()
    expect(memory.propose).not.toHaveBeenCalled()
  })

  it('listagem do acervo rejeitando não lança', async () => {
    const memory = fakeMemory()
    memory.listEntries.mockRejectedValue(new Error('banco offline'))
    const memorista = new Memorista({ config, memory: () => memory, ask: vi.fn(async () => 'OK') })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', result)
    await expect(memorista.settled('conv-1')).resolves.toBeUndefined()
  })
})

/**
 * O ponto central do M3: o memorista gastava um LLM em TODO turno. Agora um
 * gate `noul` (~100ms) responde antes, e o modelo caro só roda quando ele
 * aprova — ou quando não há gate nenhum para consultar.
 */
describe('Memorista — o gate do TypeSafe decide se o modelo roda', () => {
  const answered: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'A retenção aqui é de 5%.', durationMs: 1 }

  it('veredito NÃO impede a chamada ao modelo', async () => {
    const memory = fakeMemory()
    const ask = answer('NOVA | instrucao | x.md | X | quando | fato')
    const gate = vi.fn(async () => false)
    const memorista = new Memorista({ config, memory: () => memory, ask, gate })

    memorista.noteUserMessage('conv-1', 'C:/p', 'bom dia, tudo certo por aqui')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    // A prova é a contagem: zero chamadas ao LLM, e nada escrito.
    expect(ask).not.toHaveBeenCalled()
    expect(memory.propose).not.toHaveBeenCalled()
    expect(memory.applyPending).not.toHaveBeenCalled()
    // Dois gates no turno: a mensagem do usuário e a resposta final.
    expect(gate).toHaveBeenCalledTimes(2)
  })

  it('veredito SIM dispara o memorista com o contexto ampliado', async () => {
    const memory = fakeMemory([entry()])
    const ask = answer('OK')
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask,
      gate: async () => true,
      usedMemories: () => ['fiscal/nota.md'],
      docsIndex: async () => '[PROJECT_DOCS_INDEX] indice',
      docs: async () => '[PROJECT_DOCS_CONTEXT] documentacao completa do projeto'
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'a retenção subiu para 5%')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
    const digest = String(ask.mock.calls[0][0])
    // Conversa: pergunta e resposta.
    expect(digest).toContain('a retenção subiu para 5%')
    expect(digest).toContain('A retenção aqui é de 5%.')
    // As memórias usadas naquele prompt e os cabeçalhos das demais.
    expect(digest).toContain('MEMÓRIAS QUE O AGENTE JÁ TINHA NESTE TURNO:')
    expect(digest).toContain('- fiscal/nota.md')
    expect(digest).toContain('fiscal/nota.md — Nota de serviço: ao emitir nota')
    // E os docs do projeto COMPLETOS: aqui é um Claude de 200k.
    expect(digest).toContain('documentacao completa do projeto')
    expect(digest).not.toContain('[PROJECT_DOCS_INDEX]')
  })

  it('o gate recebe a resposta, a pergunta, as memórias usadas, os cabeçalhos e o ÍNDICE do docs', async () => {
    const memory = fakeMemory([entry()])
    const seen: MemoryGateInput[] = []
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask: answer('OK'),
      gate: async (input) => {
        seen.push(input)
        return false
      },
      usedMemories: () => ['fiscal/nota.md'],
      docsIndex: async () => '[PROJECT_DOCS_INDEX] caminhos e titulos',
      docs: async () => '[PROJECT_DOCS_CONTEXT] nao deveria chegar ao gate'
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'a retenção subiu para 5%')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    const [early, late] = seen
    // Na mensagem do usuário ainda não existe resposta.
    expect(early.userText).toContain('a retenção subiu para 5%')
    expect(early.answerText).toBeUndefined()
    // No fim do turno, a resposta final entra.
    expect(late.answerText).toBe('A retenção aqui é de 5%.')
    expect(late.usedMemories).toEqual(['fiscal/nota.md'])
    expect(late.memoryHeaders).toEqual(['fiscal/nota.md — Nota de serviço: ao emitir nota'])
    // O gate vê o ÍNDICE; o docs completo não cabe no state do Jev.
    expect(late.docsIndex).toBe('[PROJECT_DOCS_INDEX] caminhos e titulos')
  })

  it('SIM na mensagem do usuário basta, mesmo com NÃO na resposta final', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let call = 0
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask,
      gate: async () => (++call === 1 ? true : false)
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'nunca rode migração direto em produção')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('gate indisponível (null) NÃO bloqueia: o memorista volta a decidir sozinho', async () => {
    const memory = fakeMemory()
    const ask = answer('NOVA | instrucao | pnpm.md | pnpm | ao instalar | Use pnpm neste projeto.')
    const memorista = new Memorista({ config, memory: () => memory, ask, gate: async () => null })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
    expect(proposals(memory)).toHaveLength(1)
  })

  it('gate lançando é o mesmo que gate indisponível', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask,
      gate: async () => {
        throw new Error('typesafe fora do ar')
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', answered)
    await expect(memorista.settled('conv-1')).resolves.toBeUndefined()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('sem gate configurado o comportamento é o de hoje', async () => {
    const memory = fakeMemory()
    const ask = answer('NOVA | instrucao | pnpm.md | pnpm | ao instalar | Use pnpm neste projeto.')
    const memorista = new Memorista({ config, memory: () => memory, ask, gateActive: async () => false })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('turno recusado pelo gate foi julgado: não volta para a fila nem consome o cooldown', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    let allow = false
    let now = 1_000_000
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask,
      now: () => now,
      gate: async () => allow
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'bom dia, tudo certo por aqui')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')
    expect(ask).not.toHaveBeenCalled()

    // Sem avançar o relógio: nenhuma chamada foi feita, então o cooldown — que
    // existe para limitar o LLM — não pode estar valendo.
    allow = true
    memorista.noteUserMessage('conv-1', 'C:/p', 'sempre use pnpm neste projeto')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
    const digest = userSection(String(ask.mock.calls[0][0]))
    expect(digest).toContain('sempre use pnpm neste projeto')
    expect(digest).not.toContain('bom dia, tudo certo por aqui')
  })

  it('o cooldown continua valendo depois de uma análise de verdade, e o gate nem é consultado', async () => {
    const memory = fakeMemory()
    const ask = answer('OK')
    const gate = vi.fn(async () => true)
    let now = 1_000_000
    const memorista = new Memorista({ config, memory: () => memory, ask, now: () => now, gate })

    memorista.noteUserMessage('conv-1', 'C:/p', 'primeiro turno')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')
    expect(ask).toHaveBeenCalledTimes(1)

    now += 1_000
    gate.mockClear()
    memorista.noteUserMessage('conv-1', 'C:/p', 'segundo turno, dentro do cooldown')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(ask).toHaveBeenCalledTimes(1)
    // NENHUM dos dois gates roda dentro do cooldown: o do fim do turno porque a
    // análise para antes dele, e o da mensagem do usuário porque o veredito
    // dele seria descartado ali mesmo.
    expect(gate).not.toHaveBeenCalled()

    now += MEMORISTA_COOLDOWN_MS
    memorista.noteUserMessage('conv-1', 'C:/p', 'terceiro turno')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(userSection(String(ask.mock.calls[1][0]))).toContain('segundo turno, dentro do cooldown')
  })

  it('a escrita aprovada pelo gate continua passando pelo serviço com a varredura de segredos', async () => {
    const memory = fakeMemory()
    const sanitize = vi.fn(async (input: MemoryProposeInput) => ({ input, stored: [], skipped: [], notes: [] }))
    const memorista = new Memorista({
      config,
      memory: () => memory,
      sanitize: sanitize as never,
      ask: answer('NOVA | instrucao | pnpm.md | pnpm | ao instalar | Use pnpm neste projeto.'),
      gate: async () => true
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', answered)
    await memorista.settled('conv-1')

    expect(sanitize).toHaveBeenCalledTimes(1)
    expect(memory.propose).toHaveBeenCalledTimes(1)
    expect(memory.applyPending).toHaveBeenCalledTimes(1)
  })

  it('a resposta do agente vem do último bloco quando o result chega sem texto', async () => {
    const memory = fakeMemory()
    const seen: MemoryGateInput[] = []
    const memorista = new Memorista({
      config,
      memory: () => memory,
      ask: answer('OK'),
      gate: async (input) => {
        seen.push(input)
        return false
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'e aí?')
    memorista.observe('conv-1', { kind: 'assistant-text', id: 'a1', text: 'parcial', final: false })
    memorista.observe('conv-1', { kind: 'assistant-text', id: 'a2', text: 'a resposta fechada', final: true })
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(seen.at(-1)?.answerText).toBe('a resposta fechada')
  })
})

describe('Memorista — diagnóstico para o painel do elenco', () => {
  it('anuncia início e fim, com quantas memórias foram propostas', async () => {
    const memory = fakeMemory()
    const seen: MemoristaProviderDiagnostic[] = []
    const ask = vi.fn(async () => 'NOVA | instrucao | pnpm.md | pnpm | ao instalar | Use pnpm neste projeto.')
    const memorista = new Memorista({ config, memory: () => memory, ask, diagnose: (d) => void seen.push(d) })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(seen.map((item) => item.phase)).toEqual(['claude-started', 'analysis-finished'])
    expect(seen.at(-1)?.savedMemories).toBe(1)
    expect(seen.every((item) => item.correlationId === seen[0].correlationId)).toBe(true)
  })

  it('Claude com falha estruturada cai para a Luna e o fim continua sendo anunciado', async () => {
    const memory = fakeMemory()
    const seen: MemoristaProviderDiagnostic[] = []
    const memorista = new Memorista({
      config,
      memory: () => memory,
      runClaude: async () => ({ provider: 'claude', state: 'failed', reason: 'claude_plan' }),
      runLuna: async (_request: MemoristaObserverRequest, onStarted: () => void) => {
        onStarted()
        return { provider: 'gpt-luna', state: 'completed', text: 'OK' }
      },
      diagnose: (d) => void seen.push(d)
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(seen.map((item) => item.phase)).toEqual([
      'claude-started',
      'claude-unavailable',
      'memorista-provider-switch',
      'gpt-luna-started',
      'analysis-finished'
    ])
    expect(seen.at(-1)?.actualProvider).toBe('gpt-luna')
  })
})

describe('Memorista — modo Automático', () => {
  it('em Automático o modelo da análise sai da decisão, nunca o sentinel', async () => {
    const memory = fakeMemory()
    const autoModel = vi.fn(async () => 'claude-sonnet-5')
    const seen: MemoristaObserverRequest[] = []
    const memorista = new Memorista({
      config: () => config({ model: 'auto' }),
      memory: () => memory,
      autoModel,
      runClaude: async (request) => {
        seen.push(request)
        return { provider: 'claude', state: 'completed', text: 'OK' }
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm neste projeto')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(seen[0]?.model).toBe('claude-sonnet-5')
    // A decisão vê a mensagem do usuário — é sobre ela que o turno foi.
    expect(autoModel).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'use pnpm neste projeto' })
    )
  })

  it('fora do Automático não consulta ninguém: o modelo é o da configuração', async () => {
    const memory = fakeMemory()
    const autoModel = vi.fn(async () => 'claude-sonnet-5')
    const seen: MemoristaObserverRequest[] = []
    const memorista = new Memorista({
      config,
      memory: () => memory,
      autoModel,
      runClaude: async (request) => {
        seen.push(request)
        return { provider: 'claude', state: 'completed', text: 'OK' }
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm neste projeto')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(seen[0]?.model).toBe('claude-sonnet-5')
    expect(autoModel).not.toHaveBeenCalled()
  })

  it('o gate vem ANTES da escolha: turno recusado não gasta a decisão', async () => {
    const memory = fakeMemory()
    const autoModel = vi.fn(async () => 'claude-sonnet-5')
    const memorista = new Memorista({
      config: () => config({ model: 'auto' }),
      memory: () => memory,
      autoModel,
      gateActive: async () => true,
      gate: async () => false,
      runClaude: async () => ({ provider: 'claude', state: 'completed', text: 'OK' })
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'oi')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(autoModel).not.toHaveBeenCalled()
  })

  it('a escolha é restrita à lista DO MEMORISTA, não à da conversa', async () => {
    const memory = fakeMemory()
    const seen: MemoristaObserverRequest[] = []
    // Sem `autoModel`: é o caminho de produção que precisa ser visto aqui.
    const memorista = new Memorista({
      config: () => config({ model: 'auto' }),
      memory: () => memory,
      runClaude: async (request) => {
        seen.push(request)
        return { provider: 'claude', state: 'completed', text: 'OK' }
      }
    })

    memorista.noteUserMessage('conv-1', 'C:/p', 'use pnpm neste projeto')
    memorista.observe('conv-1', result)
    await memorista.settled('conv-1')

    expect(chooseAutoExecution).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'use pnpm neste projeto' }),
      { models: MEMORISTA_AUTO_MODELS }
    )
    // A lista do seletor do memorista, e nada além dela: o Fable 5.1 é mais
    // caro que o topo do que o usuário consegue escolher para ele à mão.
    expect(MEMORISTA_AUTO_MODELS).toEqual(['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5'])
    expect(seen[0]?.model).toBe('claude-sonnet-5')
  })
})
