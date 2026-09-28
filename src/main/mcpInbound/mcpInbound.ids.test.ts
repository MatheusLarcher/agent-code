/**
 * Reproduções do crítico da 7b50df69 (node_modules/.cache/critico-7b50/
 * inbound.test.ts), convertidas: a tarefa é reconhecida SÓ pelo id que o item
 * da fila leva — nunca pelo texto. Antes, o texto casava a tarefa errada.
 */
import { describe, expect, it } from 'vitest'
import type { StartAgentOptions } from '../../shared/ipc'
import { MCP_TASK_GONE } from './mcpConstants'
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
const opts: StartAgentOptions = { convId: 'c1', cwd: 'C:\\p', model: 'claude-sonnet-5-5' }
const send = (text: string, taskId?: string): McpSend => ({ text, ...(taskId ? { taskId } : {}), kind: 'normal' })

function setup(): McpInbound {
  const inbound = make()
  inbound.sessionOptions(opts)
  inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
  return inbound
}

describe('tarefa MCP casada pelo id (reproduções do crítico)', () => {
  it('"Tentar de novo" depois de erro transitório: a tarefa já terminou (regra 2) e o reenvio é RECUSADO (regra 1)', () => {
    const inbound = setup()
    const reg = inbound.registry
    const t = reg.create('c1', 'tarefa', 'gpt-6-sol')
    inbound.onAgentSend('c1', send('tarefa', t.id))
    inbound.onEvent('c1', { kind: 'error', text: 'overloaded', retryable: true } as never)
    expect(reg.get(t.id)).toMatchObject({ status: 'erro', erro: 'overloaded' })
    // O reenvio com o id: recusado, sem subir sessão nenhuma e sem virar mensagem do usuário.
    expect(inbound.refusal('c1', send('tarefa', t.id))).toBe(MCP_TASK_GONE)
    expect(inbound.restartForSend('c1', send('tarefa', t.id), live('claude-sonnet-5-5'))).toBeNull()
    expect(inbound.isTaskSend('c1', send('tarefa', t.id))).toBe(true)
    expect(reg.get(t.id)).toMatchObject({ status: 'erro', erro: 'overloaded' })
  })

  it('mesmo texto, modelos diferentes: "agora" na T2 (gpt) com a sessão em opus é RECUSADO pelo modelo da T2', () => {
    const inbound = setup()
    const reg = inbound.registry
    const t1 = reg.create('c1', 'X', 'claude-opus-5-5')
    const t2 = reg.create('c1', 'X', 'gpt-6-sol')
    expect(inbound.injectBlocked('c1', t2.id, live('claude-opus-5-5'))).toMatch(/gpt-6-sol/)
    expect([reg.get(t1.id)?.status, reg.get(t2.id)?.status]).toEqual(['na_fila', 'na_fila'])
    // O item da T1 sai depois: sobe no modelo da T1, não no da T2.
    const redo = inbound.restartForSend('c1', send('X', t1.id), live('gpt-6-sol'))
    expect(inbound.sessionOptions(redo!).model).toBe('claude-opus-5-5')
    inbound.onAgentSend('c1', send('X', t1.id))
    expect([reg.get(t1.id)?.status, reg.get(t2.id)?.status]).toEqual(['rodando', 'na_fila'])
  })

  it('mesmo texto: "agora" na T2 (gpt) com a sessão JÁ em gpt é aceito e marca a T2 (não a T1)', () => {
    const inbound = setup()
    const reg = inbound.registry
    const t1 = reg.create('c1', 'X', 'claude-opus-5-5')
    const t2 = reg.create('c1', 'X', 'gpt-6-sol')
    expect(inbound.injectBlocked('c1', t2.id, live('gpt-6-sol'))).toBeNull()
    expect(inbound.onInjected('c1', t2.id)).toBe(true)
    expect([reg.get(t1.id)?.status, reg.get(t2.id)?.status]).toEqual(['na_fila', 'rodando'])
    // E o "agora" na T1 com a sessão em gpt é recusado pelo modelo da T1.
    expect(inbound.injectBlocked('c1', t1.id, live('gpt-6-sol'))).toMatch(/claude-opus-5-5/)
  })

  it('mensagem do usuário com o texto de uma tarefa da fila: modelo da conversa, sem pin, e a tarefa continua na fila', () => {
    const inbound = setup()
    const reg = inbound.registry
    const t1 = reg.create('c1', 'A', 'claude-opus-5-5')
    const t2 = reg.create('c1', 'sim', 'gpt-6-sol')
    // Sessão viva no modelo da conversa: nada a refazer para a mensagem do usuário.
    expect(inbound.restartForSend('c1', send('sim'), live('claude-sonnet-5-5', true))).toBeNull()
    expect(inbound.pinForSend('c1', send('sim'))).toBe(false)
    // Sessão viva no gpt de outra tarefa: volta ao modelo da conversa.
    const back = inbound.restartForSend('c1', send('sim'), live('gpt-6-sol'))
    expect(inbound.sessionOptions(back!).model).toBe('claude-sonnet-5-5')
    inbound.onAgentSend('c1', send('sim'))
    expect([reg.get(t1.id)?.status, reg.get(t2.id)?.status]).toEqual(['na_fila', 'na_fila'])
  })

  it('id de tarefa de outra conversa, ou de tarefa já terminada: RECUSADO (nunca vira mensagem do usuário)', () => {
    const inbound = setup()
    const reg = inbound.registry
    const outra = reg.create('c2', 'X', 'gpt-6-sol')
    expect(inbound.refusal('c1', send('X', outra.id))).toBe(MCP_TASK_GONE)
    expect(inbound.restartForSend('c1', send('X', outra.id), live('gpt-6-sol'))).toBeNull()
    expect(reg.get(outra.id)?.status).toBe('na_fila')
    const t = reg.create('c1', 'Y', 'gpt-6-sol')
    inbound.onAgentSend('c1', send('Y', t.id))
    inbound.onEvent('c1', { kind: 'result', text: 'ok', isError: false } as never)
    expect(inbound.refusal('c1', send('Y', t.id))).toBe(MCP_TASK_GONE)
    expect(inbound.restartForSend('c1', send('Y', t.id), live('gpt-6-sol'))).toBeNull()
    expect(inbound.pinForSend('c1', send('Y', t.id))).toBe(false)
  })

  it('restart do Automático leva a cauda real da conversa (a da tela + o que passou depois), não []', () => {
    const inbound = make()
    inbound.sessionOptions({
      ...opts,
      effort: 'auto',
      autoPrompt: { message: 'primeira', history: [{ who: 'user', text: 'antes' }, { who: 'agent', text: 'resposta antes' }] }
    })
    inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
    inbound.onAgentSend('c1', send('primeira'))
    inbound.onEvent('c1', { kind: 'result', text: 'feito', isError: false } as never)
    const t = inbound.registry.create('c1', 'peça', 'gpt-6-sol')
    const redo = inbound.restartForSend('c1', send('peça', t.id), live('claude-sonnet-5-5', false))
    expect(redo?.autoPrompt).toEqual({
      message: 'peça',
      history: [
        { who: 'user', text: 'antes' },
        { who: 'agent', text: 'resposta antes' },
        { who: 'user', text: 'primeira' },
        { who: 'agent', text: 'feito' }
      ]
    })
  })
})
