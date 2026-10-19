// @vitest-environment node
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { TarefaRegistro } from '../persistence/tarefaTypes'
import { executarRodadaMonitor, RODADA_FERRAMENTAS_PROIBIDAS, type Resposta, type RodadaQueryFn } from './rodadaMonitor'

/**
 * A rodada do monitor com uma consulta FALSA do SDK: o resultado vem só pelo
 * `aviso_resultado`, o CLI é fechado sempre (fim, erro, cancelamento) e as
 * opções levam as travas (bypass, sem AskUserQuestion, sem tarefa de fundo).
 */

const tarefa = (over: Partial<TarefaRegistro> = {}): TarefaRegistro => ({
  id: 't1', tipo: 'monitor', titulo: 'Dólar', mensagem: null, convId: 'c1', cwd: 'Z:\\nao-existe', agenda: { tipo: 'intervalo', intervaloMin: 10 },
  estado: 'ativa', modelo: 'claude-haiku-5-5', condicao: 'cotação do dólar acima de R$ 10', combinado: null, criadaPor: 'pc-a',
  criadaEm: '2026-10-19T12:00:00Z', atualizadaEm: '2026-10-19T12:00:00Z', proximaEm: '2026-10-19T12:00:00Z', ultimaEm: null,
  ultimoResultado: null, ultimoValor: null, avisadoValor: null, falhasSeguidas: 0, bateuNaoVistoEm: null, leaseDono: null, leaseToken: null, leaseAte: null, ...over
})

type Guardar = (r: Resposta) => void
const fakeServer = (guardar: Guardar): McpServerConfig => ({ guardar }) as unknown as McpServerConfig

/** Consulta falsa: roteiro com acesso ao `guardar` e às opções; conta os `close()`. */
function consulta(roteiro: (ctx: { guardar: Guardar; options: Options }) => AsyncGenerator<unknown>) {
  const closes = vi.fn()
  let options: Options | null = null
  const run: RodadaQueryFn = ({ options: o }) => {
    options = o
    const guardar = (o.mcpServers?.avisos as unknown as { guardar: Guardar }).guardar
    const it = roteiro({ guardar, options: o })
    return Object.assign(it, { close: closes })
  }
  return { run, closes, options: () => options! }
}

const ctx = (signal = new AbortController().signal) => ({ signal, atrasadaMs: 0, timeoutMs: 600_000 })
const deps = (run: RodadaQueryFn) => ({ query: run, env: async () => undefined, servidorResultado: fakeServer })

describe('rodada do monitor', () => {
  it('bateu: o resultado vem do aviso_resultado e o CLI fecha', async () => {
    const q = consulta(async function* ({ guardar }) {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__avisos__aviso_resultado' }] } }
      guardar({ bateu: true, valor: 'R$ 10,20', resumo: 'Banco Central', fonte: 'https://bcb.gov.br' })
      yield { type: 'user' }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'não deveria chegar aqui' }] } }
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(q.run))).toEqual({ resultado: 'bateu', valor: 'R$ 10,20', resumo: 'Banco Central', fonte: 'https://bcb.gov.br' })
    expect(q.closes).toHaveBeenCalledTimes(1)
  })

  it('não bateu e "precisa de você" viram o resultado certo', async () => {
    const nao = consulta(async function* ({ guardar }) {
      guardar({ bateu: false, valor: 'R$ 5,40' })
      yield { type: 'result', subtype: 'success' }
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(nao.run))).toMatchObject({ resultado: 'nao-bateu', valor: 'R$ 5,40' })
    const precisa = consulta(async function* ({ guardar }) {
      guardar({ bateu: false, precisa_de_voce: true, resumo: 'pede login' })
      yield { type: 'user' }
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(precisa.run))).toMatchObject({ resultado: 'precisa-de-voce', resumo: 'pede login' })
  })

  it('sem aviso_resultado é falha; erro do SDK e cota esgotada também — e fecha sempre', async () => {
    const mudo = consulta(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'olhei e pronto' }] } }
      yield { type: 'result', subtype: 'success' }
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(mudo.run))).toEqual({ resultado: 'falha', falha: 'a rodada terminou sem aviso_resultado' })
    const quebra = consulta(async function* () {
      yield { type: 'system' }
      throw new Error('CLI morreu')
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(quebra.run))).toEqual({ resultado: 'falha', falha: 'a rodada falhou: CLI morreu' })
    expect(quebra.closes).toHaveBeenCalledTimes(1)
    const turnos = consulta(async function* () {
      yield { type: 'result', subtype: 'error_max_turns', errors: ['maxTurns'] }
    })
    expect(await executarRodadaMonitor(tarefa(), ctx(), deps(turnos.run))).toMatchObject({ resultado: 'falha', falha: 'a rodada falhou: maxTurns' })
  })

  it('cancelada no meio (prazo/pausa): aborta a consulta, fecha e devolve falha', async () => {
    const controller = new AbortController()
    let abortSdk: AbortSignal | undefined
    const q = consulta(async function* ({ options }) {
      abortSdk = options.abortController?.signal
      yield { type: 'system' }
      await new Promise((resolve) => setTimeout(resolve, 60_000))
    })
    const rodando = executarRodadaMonitor(tarefa(), ctx(controller.signal), deps(q.run))
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(await rodando).toEqual({ resultado: 'falha', falha: 'interrompida' })
    expect(abortSdk?.aborted).toBe(true)
    expect(q.closes).toHaveBeenCalledTimes(1)
  })

  it('opções: bypass sem AskUserQuestion, sem tarefa de fundo, sem sessão gravada; pasta sumida cai no home', async () => {
    const q = consulta(async function* ({ guardar }) {
      guardar({ bateu: false })
      yield { type: 'user' }
    })
    const extras = vi.fn(() => ({ servidores: { chrome: { type: 'sdk' } as unknown as McpServerConfig }, encerrar: vi.fn() }))
    await executarRodadaMonitor(tarefa(), ctx(), { ...deps(q.run), ferramentas: extras })
    const o = q.options()
    expect(o).toMatchObject({ model: 'claude-haiku-5-5', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, persistSession: false, maxTurns: 40 })
    expect(o.disallowedTools).toEqual(expect.arrayContaining([...RODADA_FERRAMENTAS_PROIBIDAS]))
    expect(o.disallowedTools).toContain('AskUserQuestion')
    expect(o.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(o.cwd).not.toBe('Z:\\nao-existe')
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(['avisos', 'chrome'])
    expect(extras.mock.results[0].value.encerrar).toHaveBeenCalledTimes(1)
  })

  it('o prompt leva a condição, o combinado e o último resultado', async () => {
    let prompt = ''
    const run: RodadaQueryFn = ({ prompt: p, options }) => {
      const guardar = (options.mcpServers?.avisos as unknown as { guardar: Guardar }).guardar
      return (async function* () {
        for await (const m of p) prompt = String((m.message.content as { text: string }[])[0].text)
        guardar({ bateu: false })
        yield { type: 'user' }
      })()
    }
    await executarRodadaMonitor(tarefa({ combinado: 'só o site do BC', ultimaEm: '2026-10-19T14:00:00Z', ultimoResultado: 'nao-bateu', ultimoValor: 'R$ 5,40' }), ctx(), deps(run))
    expect(prompt).toContain('Condição para avisar: cotação do dólar acima de R$ 10')
    expect(prompt).toContain('só o site do BC')
    expect(prompt).toContain('nao-bateu (R$ 5,40)')
    expect(prompt).toContain('aviso_resultado')
  })
})
