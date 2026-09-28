import { describe, expect, it } from 'vitest'
import type { ChatEvent, PermissionRequest } from '../../shared/ipc'
import { McpTaskRegistry, SUPERSEDED, shortError } from './mcpTasks'

let seq = 0
const registry = (): McpTaskRegistry => new McpTaskRegistry(() => 1000, () => `t${++seq}`)
const result = (text: string, isError = false): ChatEvent =>
  ({ kind: 'result', isError, text, durationMs: 1 }) as ChatEvent
const question = (id: string): PermissionRequest => ({
  id,
  toolName: 'AskUserQuestion',
  input: {},
  questions: [{ header: 'Furo', question: 'Qual diâmetro?', multiSelect: false, options: [{ label: '8 mm', description: '' }] }],
  deadline: 5000
})

describe('McpTaskRegistry — transições', () => {
  it('na_fila → rodando (agent:send com o id dela) → concluida com a resposta', () => {
    const r = registry()
    const t = r.create('c1', 'aumente o furo')
    expect(t.status).toBe('na_fila')
    r.noteSend('c1', undefined)
    expect(r.get(t.id)?.status).toBe('na_fila')
    // Texto igual, sem id: é mensagem do usuário, a tarefa não começa.
    r.noteSend('c1', undefined)
    expect(r.get(t.id)?.status).toBe('na_fila')
    r.noteSend('c1', t.id)
    expect(r.get(t.id)?.status).toBe('rodando')
    r.observe('c1', result('Pronto: furo com 8 mm.'))
    expect(r.get(t.id)).toMatchObject({ status: 'concluida', resposta: 'Pronto: furo com 8 mm.' })
  })

  it('duas na mesma conversa: a 2ª espera na fila até a 1ª terminar', () => {
    const r = registry()
    const a = r.create('c1', 'A')
    const b = r.create('c1', 'B')
    r.noteSend('c1', a.id)
    expect([r.get(a.id)?.status, r.get(b.id)?.status]).toEqual(['rodando', 'na_fila'])
    r.observe('c1', result('ok A'))
    r.noteSend('c1', b.id)
    expect([r.get(a.id)?.status, r.get(b.id)?.status]).toEqual(['concluida', 'rodando'])
  })

  it('reenvio do item da tarefa aberta (mesmo id) continua o turno; envio sem id o encerra como erro', () => {
    const r = registry()
    const t = r.create('c1', 'x')
    r.noteSend('c1', t.id)
    // O mesmo item de novo (ex.: devolvido à fila pelo reparo do espelho).
    r.noteSend('c1', t.id)
    expect(r.taskFor('c1', t.id)).toBe(r.get(t.id))
    expect(r.get(t.id)?.status).toBe('rodando')
    r.noteSend('c1', undefined)
    expect(r.get(t.id)).toMatchObject({ status: 'erro', erro: SUPERSEDED })
    expect(r.taskFor('c1', t.id)).toBeUndefined()
  })

  it('regra 2: QUALQUER erro encerra a tarefa — retryable (529), limite de uso, definitivo, result isError', () => {
    const r = registry()
    const a = r.create('c1', 'a')
    r.noteSend('c1', a.id)
    r.observe('c1', { kind: 'error', id: 'e', text: 'API Error: 529 overloaded', retryable: true } as ChatEvent)
    expect(r.get(a.id)).toMatchObject({ status: 'erro', erro: 'API Error: 529 overloaded' })
    expect(r.taskFor('c1', a.id)).toBeUndefined()
    const b = r.create('c1', 'b')
    r.noteSend('c1', b.id)
    r.observe('c1', { kind: 'error', id: 'e2', text: 'Limite de uso atingido', usageExhausted: true } as ChatEvent)
    expect(r.get(b.id)).toMatchObject({ status: 'erro', erro: 'Limite de uso atingido' })
    const u = r.create('c2', 'y')
    r.noteSend('c2', u.id)
    r.observe('c2', result('falhou feio', true))
    expect(r.get(u.id)).toMatchObject({ status: 'erro', erro: 'falhou feio' })
  })

  it('lastTurnWasTask: o último turno aberto pelo agent:send era de tarefa? (a retomada nunca muda)', () => {
    const r = registry()
    expect(r.lastTurnWasTask('c1')).toBe(false)
    const t = r.create('c1', 'x')
    r.noteSend('c1', t.id)
    expect(r.lastTurnWasTask('c1')).toBe(true)
    r.observe('c1', result('falhou', true))
    r.noteSend('c1', undefined, 'recovery')
    expect(r.lastTurnWasTask('c1')).toBe(true)
    r.noteSend('c1', undefined)
    expect(r.lastTurnWasTask('c1')).toBe(false)
  })

  it('tarefa que entra pelo "agora" num turno do usuário marca o turno como de tarefa', () => {
    const r = registry()
    r.noteSend('c1', undefined)
    expect(r.lastTurnWasTask('c1')).toBe(false)
    const t = r.create('c1', 'ajuste')
    r.noteInjected('c1', t.id)
    expect(r.lastTurnWasTask('c1')).toBe(true)
    // O turno do usuário (com a tarefa dentro) dá 529: a tarefa termina em erro
    // e a retomada automática NÃO desmarca — ela seria recusada (regra 2).
    r.observe('c1', { kind: 'error', id: 'e', text: 'API Error: 529 overloaded', retryable: true } as ChatEvent)
    expect(r.get(t.id)?.status).toBe('erro')
    r.noteSend('c1', undefined, 'recovery')
    expect(r.lastTurnWasTask('c1')).toBe(true)
  })

  it('sessão trocada no meio do turno: a tarefa aberta termina em erro com o motivo', () => {
    const r = registry()
    const t = r.create('c1', 'x')
    const fila = r.create('c1', 'y')
    r.noteSend('c1', t.id)
    r.onSessionReplaced('c1', 'sessão refeita')
    expect(r.get(t.id)).toMatchObject({ status: 'erro', erro: 'sessão refeita' })
    expect(r.get(fila.id)?.status).toBe('na_fila')
  })

  it('cancelar: na fila sai já; rodando pede o Stop e o Stop a cancela', () => {
    const r = registry()
    const a = r.create('c1', 'A')
    const b = r.create('c1', 'B')
    expect(r.cancel(b.id)).toBe('drop-queued')
    expect(r.get(b.id)?.status).toBe('cancelada')
    r.noteSend('c1', a.id)
    expect(r.cancel(a.id)).toBe('interrupt')
    r.onInterrupt('c1')
    expect(r.get(a.id)?.status).toBe('cancelada')
    r.observe('c1', result('resposta que chegou depois do Stop'))
    expect(r.get(a.id)?.status).toBe('cancelada')
    expect(r.cancel(a.id)).toBe('none')
  })

  it('Stop (ou "parar sessão") cancela só o turno; a fila é avisada pelo renderer (dropped)', () => {
    const r = registry()
    const a = r.create('c1', 'A')
    const b = r.create('c1', 'B')
    r.noteSend('c1', a.id)
    r.onInterrupt('c1')
    expect(r.get(b.id)?.status).toBe('na_fila')
    r.dropped(b.id, 'Cancelada: a conversa foi interrompida')
    expect(r.get(b.id)).toMatchObject({ status: 'cancelada', erro: 'Cancelada: a conversa foi interrompida' })
    expect(r.get(a.id)?.status).toBe('cancelada')
  })

  it('pergunta: vai para o chamador e volta a rodando ao responder', () => {
    const r = registry()
    const t = r.create('c1', 'x')
    r.onQuestion('c1', question('q1')) // antes de rodar: ignora
    expect(r.get(t.id)?.status).toBe('na_fila')
    r.noteSend('c1', t.id)
    r.onQuestion('c1', question('q1'))
    expect(r.get(t.id)).toMatchObject({ status: 'pergunta', pergunta: { id: 'q1', prazo: 5000 } })
    r.onQuestionClosed('c1', 'outra')
    expect(r.get(t.id)?.status).toBe('pergunta')
    r.onQuestionClosed('c1', 'q1')
    expect(r.get(t.id)?.status).toBe('rodando')
    expect(r.get(t.id)?.pergunta).toBeUndefined()
  })

  it('"agora" (injectNow): a tarefa do id entra no turno e termina com ele', () => {
    const r = registry()
    const a = r.create('c1', 'A')
    const b = r.create('c1', 'B')
    r.noteSend('c1', a.id)
    expect(r.noteInjected('c1', undefined)).toBeUndefined()
    r.noteInjected('c1', b.id)
    r.observe('c1', result('feito A e B'))
    expect([r.get(a.id)?.status, r.get(b.id)?.status]).toEqual(['concluida', 'concluida'])
  })

  it('conversa descartada com turno aberto, e falha de entrega do renderer', () => {
    const r = registry()
    const a = r.create('c1', 'A')
    r.noteSend('c1', a.id)
    r.onDispose('c1')
    expect(r.get(a.id)).toMatchObject({ status: 'erro', erro: 'A conversa foi fechada no Agent Code.' })
    const b = r.create('c2', 'B')
    r.fail(b.id, 'A conversa não foi encontrada no Agent Code.')
    expect(r.get(b.id)).toMatchObject({ status: 'erro' })
    r.noteSend('c2', b.id)
    expect(r.get(b.id)?.status).toBe('erro')
  })

  it('config por conversa e mensagem curta', () => {
    const r = registry()
    r.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
    expect(r.configFor('c1')?.cliente).toBe('Forgia')
    expect(r.configFor('c2')).toBeUndefined()
    expect(shortError('')).toMatch(/sem mensagem/)
    expect(shortError('x'.repeat(500))).toHaveLength(401)
  })
})
