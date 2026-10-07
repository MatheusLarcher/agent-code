// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import {
  PO_AGENT_DISALLOWED_TOOLS,
  PO_AGENT_MAX_TURNS,
  PO_AGENT_SYSTEM_APPEND,
  poAgentOptions,
  runPoAgentQuery,
  type PoAgentQueryFn
} from './poAgentQuery'

/**
 * O modo PO com ferramentas, com o SDK simulado: as travas estão na consulta
 * (git bloqueado por escopo, modo auto, ninguém aprova o que o classificador
 * não aprova, teto de turnos), e prazo, teto e cancelamento viram estado — a
 * consulta nunca lança.
 */

const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { content: blocks } })
const result = (over: Record<string, unknown>) => ({ type: 'result', subtype: 'success', num_turns: 3, result: '', ...over })

function fake(messages: unknown[], seen?: { options?: Options }): PoAgentQueryFn {
  return ({ options }) => {
    if (seen) seen.options = options
    return (async function* () {
      for (const message of messages) yield message
    })()
  }
}

/** Uma consulta que fica pendurada até o abort (como o SDK de verdade). */
function hanging(seen?: { options?: Options }): PoAgentQueryFn {
  return ({ options }) => {
    if (seen) seen.options = options
    return (async function* () {
      await new Promise<void>((_, reject) => {
        options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })()
  }
}

const req = { prompt: 'Decida.', cwd: 'C:/proj', model: 'claude-opus-5-5' }

describe('poAgentOptions — as travas', () => {
  it('ferramentas do agente normal, git bloqueado por escopo, modo auto, teto de turnos', async () => {
    const options = poAgentOptions({ ...req, additionalDirectories: ['C:/tmp/aval', 'C:/tmp/aval'] }, new AbortController())
    expect(options.tools).toBeUndefined()
    expect(options.disallowedTools).toEqual([
      'Bash(git commit*)',
      'Bash(git push*)',
      'Bash(git reset*)',
      'Bash(git checkout*)',
      'Bash(git restore*)',
      'Bash(git stash*)',
      'Bash(git clean*)'
    ])
    expect(options.disallowedTools).toEqual([...PO_AGENT_DISALLOWED_TOOLS])
    expect(options.permissionMode).toBe('auto')
    expect(options.maxTurns).toBe(PO_AGENT_MAX_TURNS)
    expect(options.maxTurns).toBe(30)
    expect(options.cwd).toBe('C:/proj')
    expect(options.settingSources).toEqual(['user', 'project', 'local'])
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: PO_AGENT_SYSTEM_APPEND })
    expect(PO_AGENT_SYSTEM_APPEND).toMatch(/Evite modificar arquivos/)
    expect(options.additionalDirectories).toEqual(['C:/tmp/aval'])
    expect(options.persistSession).toBe(false)
    // O que o classificador não decide, ninguém aprova: ninguém está olhando.
    const decision = await options.canUseTool!('Bash', { command: 'rm -rf x' }, { signal: new AbortController().signal } as never)
    expect(decision?.behavior).toBe('deny')
  })
})

describe('runPoAgentQuery — com o SDK simulado', () => {
  it('completa: a resposta final, o texto todo e as ferramentas usadas vão para o registro', async () => {
    const seen: { options?: Options } = {}
    const out = await runPoAgentQuery(
      req,
      fake(
        [
          assistant([{ type: 'text', text: 'Vou olhar o git.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]),
          assistant([{ type: 'text', text: 'ESPERAR | o B mexe nos mesmos arquivos' }]),
          result({ result: 'ESPERAR | o B mexe nos mesmos arquivos', num_turns: 2 })
        ],
        seen
      )
    )
    expect(out).toMatchObject({ state: 'completed', text: 'ESPERAR | o B mexe nos mesmos arquivos', turns: 2 })
    expect(out.transcript).toContain('Vou olhar o git.')
    expect(out.tools).toEqual([{ name: 'Bash', input: '{"command":"git status"}' }])
    expect(seen.options?.disallowedTools).toContain('Bash(git commit*)')
  })

  it('teto de turnos e falha do SDK viram estado, nunca exceção', async () => {
    expect(await runPoAgentQuery(req, fake([result({ subtype: 'error_max_turns', errors: [] })]))).toMatchObject({ state: 'max-turns' })
    expect(await runPoAgentQuery(req, fake([result({ subtype: 'error_during_execution', errors: ['caiu'] })]))).toMatchObject({ state: 'failed', error: 'caiu' })
    const throwing: PoAgentQueryFn = () =>
      (async function* () {
        throw new Error('sem login')
      })()
    expect(await runPoAgentQuery(req, throwing)).toMatchObject({ state: 'failed', error: 'sem login' })
  })

  it('passou do prazo: a consulta é abortada e volta como timeout', async () => {
    const out = await runPoAgentQuery({ ...req, timeoutMs: 20 }, hanging())
    expect(out.state).toBe('timeout')
  })

  it('cancelada de fora (o usuário voltou): aborted', async () => {
    const abort = new AbortController()
    const pending = runPoAgentQuery({ ...req, signal: abort.signal }, hanging())
    abort.abort()
    expect((await pending).state).toBe('aborted')
    const already = new AbortController()
    already.abort()
    expect((await runPoAgentQuery({ ...req, signal: already.signal }, hanging())).state).toBe('aborted')
  })

  it('cancelada ou no prazo, volta na hora: não espera o SDK encerrar o CLI (no Windows, até ~7 s)', async () => {
    // O SDK que demora a sair depois do abort (aqui, nunca sai) e ainda manda texto depois.
    const gate: { late?: () => void } = {}
    const slow: PoAgentQueryFn = () =>
      (async function* () {
        await new Promise<void>((resolve) => (gate.late = resolve))
        yield assistant([{ type: 'text', text: 'chegou depois do cancelar' }, { type: 'tool_use', name: 'Read', input: {} }])
        await new Promise<void>(() => {})
      })()
    const abort = new AbortController()
    const pending = runPoAgentQuery({ ...req, signal: abort.signal }, slow)
    abort.abort()
    const out = await pending
    expect(out.state).toBe('aborted')
    gate.late?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(out.tools).toEqual([])
    expect(out.transcript).toBe('')
    expect((await runPoAgentQuery({ ...req, timeoutMs: 20 }, () => (async function* () { await new Promise<void>(() => {}) })())).state).toBe('timeout')
  })
})
