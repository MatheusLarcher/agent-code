/**
 * As três regras do MCP de entrada (continuação 2 da 7b50df69), no McpInbound.
 * As sondas do crítico (node_modules/.cache/critico-7b50-r2/probe*.test.ts)
 * estão convertidas aqui com o comportamento CERTO: antes elas passavam porque
 * confirmavam o rebaixamento a mensagem do usuário e a retomada noutro modelo.
 *
 * 1. Envio com id de tarefa que não está viva é RECUSADO, nunca rebaixado.
 * 2. O app não repete turno de tarefa MCP: erro encerra a tarefa, sem retomada.
 * +  Sessão nova no meio do turno encerra a tarefa com erro.
 */
import { describe, expect, it } from 'vitest'
import type { StartAgentOptions } from '../../shared/ipc'
import { isMcpTaskGone } from '../../shared/mcpInbound'
import { MCP_NO_AUTO_RETRY, MCP_SESSION_REPLACED, MCP_TASK_GONE } from './mcpConstants'
import { McpInbound, type LiveSessionState, type McpSend } from './mcpInbound'

const make = (): McpInbound =>
  new McpInbound({
    version: 't',
    conversationExists: async () => true,
    deliverToRenderer: () => {},
    dropQueuedInRenderer: () => {},
    interruptInRenderer: () => {},
    answerInRenderer: () => {}
  })
const live = (model: string, mcp = true): LiveSessionState => ({ model, mcp })
const opts: StartAgentOptions = { convId: 'c1', cwd: 'C:\\p', model: 'claude-opus-5-5' }
const forgia = { cliente: 'Forgia', mcpServers: { forgia: { command: 'x', args: [], env: {} } } }

function withTask(model = 'gpt-6-sol'): { inbound: McpInbound; id: string; send: McpSend } {
  const inbound = make()
  inbound.sessionOptions(opts)
  inbound.registry.setConfig('c1', forgia)
  const t = inbound.registry.create('c1', 'faca a peca', model)
  return { inbound, id: t.id, send: { text: 'faca a peca', taskId: t.id } }
}

describe('regra 1: id de tarefa que não está viva é recusado (sondas do crítico convertidas)', () => {
  it('Tentar de novo depois da TROCA que falhou: recusado — nada sobe, nada vira mensagem do usuário', () => {
    const { inbound, id, send } = withTask()
    const redo1 = inbound.restartForSend('c1', send, live('claude-opus-5-5', false))
    expect(inbound.sessionOptions(redo1!).model).toBe('gpt-6-sol')
    inbound.failStart('c1', send, 'Não consegui trocar o modelo da conversa: x')
    expect(inbound.registry.get(id)?.status).toBe('erro')
    // O clique em "Tentar de novo" leva o mesmo id.
    expect(inbound.refusal('c1', send)).toBe(MCP_TASK_GONE)
    expect(isMcpTaskGone(new Error(inbound.refusal('c1', send)!))).toBe(true)
    expect(inbound.restartForSend('c1', send, live('claude-opus-5-5', false))).toBeNull()
    // É envio de tarefa (nunca "do usuário"), e o registro não muda.
    expect(inbound.isTaskSend('c1', send)).toBe(true)
    expect(inbound.registry.get(id)).toMatchObject({ status: 'erro', erro: 'Não consegui trocar o modelo da conversa: x' })
  })

  it('Tentar de novo depois de erro definitivo (result isError): recusado', () => {
    const { inbound, send } = withTask()
    inbound.onAgentSend('c1', send)
    inbound.onEvent('c1', { kind: 'result', id: 'r', isError: true, text: 'falhou', durationMs: 1 } as never)
    expect(inbound.refusal('c1', send)).toBe(MCP_TASK_GONE)
  })

  it('tarefa cancelada (na fila ou rodando): o item que sobrou é recusado', () => {
    const { inbound, id, send } = withTask()
    expect(inbound.registry.cancel(id)).toBe('drop-queued')
    expect(inbound.refusal('c1', send)).toBe(MCP_TASK_GONE)
  })

  it('fila restaurada do conversation_outbox depois de reiniciar (registro vazio, sem config): recusado', () => {
    const inbound = make() // app reiniciado: registro e configs só em memória, vazios
    inbound.sessionOptions(opts)
    const send: McpSend = { text: 'faca a peca', taskId: 't-antigo' }
    expect(inbound.refusal('c1', send)).toBe(MCP_TASK_GONE)
    expect(inbound.isTaskSend('c1', send)).toBe(true)
    expect(inbound.restartForSend('c1', send, live('claude-opus-5-5'))).toBeNull()
    expect(inbound.pinForSend('c1', send)).toBe(false)
  })

  it('"agora" com id morto: recusado pela mesma regra (o index devolve gone)', () => {
    const { inbound, send } = withTask()
    inbound.onAgentSend('c1', send)
    inbound.onEvent('c1', { kind: 'result', id: 'r', isError: false, text: 'ok', durationMs: 1 } as never)
    expect(inbound.refusal('c1', { text: send.text, taskId: send.taskId })).toBe(MCP_TASK_GONE)
    // Viva (na fila): passa.
    const outra = inbound.registry.create('c1', 'outra', 'gpt-6-sol')
    expect(inbound.refusal('c1', { text: 'outra', taskId: outra.id })).toBeNull()
  })

  it('envio sem id (mensagem do usuário) nunca é recusado', () => {
    const { inbound } = withTask()
    expect(inbound.refusal('c1', { text: 'faca a peca' })).toBeNull()
  })
})

describe('regra 2: turno de tarefa que termina em erro não é repetido pelo app', () => {
  for (const [nome, event] of [
    ['529 (result isError)', { kind: 'result', id: 'r', isError: true, text: 'API Error: 529 overloaded', durationMs: 1 }],
    ['529 (error retryable)', { kind: 'error', id: 'e', text: 'API Error: 529 overloaded', retryable: true }],
    ['limite de uso', { kind: 'error', id: 'e', text: 'Claude usage limit reached', usageExhausted: true, retryable: false }]
  ] as const) {
    it(`${nome} numa tarefa gpt: tarefa em erro com o motivo; a retomada é recusada e não sobe sessão em outro modelo`, () => {
      const { inbound, id, send } = withTask('gpt-6-sol')
      const r1 = inbound.restartForSend('c1', send, live('claude-opus-5-5', false))
      inbound.sessionOptions(r1!)
      inbound.clearRestart('c1')
      inbound.onAgentSend('c1', send)
      inbound.onEvent('c1', event as never)
      expect(inbound.registry.get(id)).toMatchObject({ status: 'erro', erro: event.text })
      const rec: McpSend = { text: 'Continue exatamente de onde parou.', kind: 'recovery' }
      expect(inbound.refusal('c1', rec)).toBe(MCP_NO_AUTO_RETRY)
      // A sonda 2 do crítico: antes subia em claude-opus-5-5 com a config do Forgia e sem pin.
      expect(inbound.restartForSend('c1', rec, live('gpt-6-sol', true))).toBeNull()
      expect(inbound.pinForSend('c1', rec)).toBe(false)
    })
  }
})

describe('sessão trocada no meio do turno de tarefa', () => {
  it('a tarefa aberta termina em erro claro; a sessão nova sobe no modelo da conversa (não no da tarefa)', () => {
    const { inbound, id, send } = withTask('gpt-6-sol')
    inbound.onAgentSend('c1', send)
    expect(inbound.registry.get(id)?.status).toBe('rodando')
    // A tela reconecta (agent:start): a sessão sobe e é instalada.
    expect(inbound.sessionOptions(opts).model).toBe('claude-opus-5-5')
    inbound.onSessionInstalled('c1')
    expect(inbound.registry.get(id)).toMatchObject({ status: 'erro', erro: MCP_SESSION_REPLACED })
    expect(inbound.refusal('c1', send)).toBe(MCP_TASK_GONE)
  })

  it('sem turno aberto, instalar sessão não mexe em nada (a fila continua na fila)', () => {
    const { inbound, id } = withTask()
    inbound.onSessionInstalled('c1')
    expect(inbound.registry.get(id)?.status).toBe('na_fila')
  })
})
