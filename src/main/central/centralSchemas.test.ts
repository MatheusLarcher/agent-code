// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CentralCorrection, CentralRouteRequest } from '../../shared/central'
import { parseCorrection, parseRouteRequest } from './centralSchemas'

const conversation = { kind: 'conversation', convId: 'a1', cwd: 'C:\\work\\alpha', project: 'alpha', title: 'Login', sandbox: false }
const newConversation = { kind: 'new-conversation', cwd: 'C:\\work\\alpha', project: 'alpha' }
const newSandbox = { kind: 'new-sandbox' }

const validRequest = (): CentralRouteRequest => ({
  text: 'o botão ficou torto',
  attachments: ['print.png'],
  recent: [{ convId: 'a1', request: 'arruma o login', replyStart: 'Arrumei', cwd: 'C:\\work\\alpha', title: 'Login' }]
})

const validCorrection = (): CentralCorrection => ({
  ts: 1_759_400_000_000,
  text: 'o botão ficou torto',
  attachments: [],
  from: conversation as CentralCorrection['from'],
  fromRule: 'continua',
  fromConfidence: 0.72,
  to: newSandbox as CentralCorrection['to']
})

describe('parseRouteRequest', () => {
  it('aceita o pedido bem formado e devolve o texto aparado', () => {
    expect(parseRouteRequest({ ...validRequest(), text: '  o botão ficou torto \n' })).toEqual(validRequest())
  })

  it.each([
    ['forceAsk + exclude de conversa', { forceAsk: true, exclude: conversation }],
    ['exclude de conversa nova', { exclude: newConversation }],
    ['exclude de sandbox novo', { forceAsk: false, exclude: newSandbox }]
  ])('aceita %s', (_name, extra) => {
    expect(parseRouteRequest({ ...validRequest(), ...extra })).toEqual({ ...validRequest(), ...extra })
  })

  it('recentes sem cwd/título valem (campos opcionais)', () => {
    const req = { text: 'oi', attachments: [], recent: [{ convId: 'a1', request: '', replyStart: '' }] }
    expect(parseRouteRequest(req)).toEqual(req)
  })

  it('descarta campos desconhecidos', () => {
    const parsed = parseRouteRequest({ ...validRequest(), extra: 'x', recent: [{ ...validRequest().recent[0], lixo: 1 }] })
    expect(parsed).toEqual(validRequest())
  })

  it.each([
    ['nada', undefined],
    ['null', null],
    ['texto solto', 'oi'],
    ['sem texto', { attachments: [], recent: [] }],
    ['texto vazio', { ...validRequest(), text: '' }],
    ['texto só com espaço', { ...validRequest(), text: '   \n ' }],
    ['texto longo demais', { ...validRequest(), text: 'x'.repeat(20_001) }],
    ['texto não-string', { ...validRequest(), text: 42 }],
    ['anexos demais', { ...validRequest(), attachments: Array.from({ length: 21 }, (_, i) => `f${i}.png`) }],
    ['nome de anexo longo demais', { ...validRequest(), attachments: ['x'.repeat(201)] }],
    ['anexo não-string', { ...validRequest(), attachments: [{ name: 'a.png' }] }],
    ['sem attachments', { text: 'oi', recent: [] }],
    ['recentes demais', { ...validRequest(), recent: Array.from({ length: 6 }, (_, i) => ({ convId: `c${i}`, request: '', replyStart: '' })) }],
    ['convId vazio', { ...validRequest(), recent: [{ convId: '', request: '', replyStart: '' }] }],
    ['convId longo demais', { ...validRequest(), recent: [{ convId: 'c'.repeat(101), request: '', replyStart: '' }] }],
    ['pedido longo demais', { ...validRequest(), recent: [{ convId: 'a', request: 'x'.repeat(2001), replyStart: '' }] }],
    ['começo de resposta longo demais', { ...validRequest(), recent: [{ convId: 'a', request: '', replyStart: 'x'.repeat(2001) }] }],
    ['recente sem replyStart', { ...validRequest(), recent: [{ convId: 'a', request: '' }] }],
    ['cwd não-string', { ...validRequest(), recent: [{ convId: 'a', request: '', replyStart: '', cwd: 3 }] }],
    ['forceAsk não-booleano', { ...validRequest(), forceAsk: 'sim' }],
    ['exclude de tipo desconhecido', { ...validRequest(), exclude: { kind: 'planeta' } }],
    ['exclude de conversa sem convId', { ...validRequest(), exclude: { ...conversation, convId: undefined } }],
    ['exclude de conversa nova sem cwd', { ...validRequest(), exclude: { kind: 'new-conversation', project: 'alpha' } }],
    ['exclude de conversa sem sandbox', { ...validRequest(), exclude: { ...conversation, sandbox: undefined } }]
  ])('recusa %s', (_name, payload) => {
    expect(() => parseRouteRequest(payload)).toThrow(/rota da Central/)
  })
})

describe('parseCorrection', () => {
  it('aceita a correção bem formada', () => {
    expect(parseCorrection(validCorrection())).toEqual(validCorrection())
  })

  it('fromRule e fromConfidence são opcionais', () => {
    const { fromRule: _rule, fromConfidence: _confidence, ...rest } = validCorrection()
    expect(parseCorrection(rest)).toEqual(rest)
  })

  it.each([
    ['nada', undefined],
    ['ts não-número', { ...validCorrection(), ts: '2026' }],
    ['ts negativo', { ...validCorrection(), ts: -1 }],
    ['texto vazio', { ...validCorrection(), text: ' ' }],
    ['anexos demais', { ...validCorrection(), attachments: Array.from({ length: 21 }, () => 'a') }],
    ['from malformado', { ...validCorrection(), from: { kind: 'conversation' } }],
    ['to ausente', { ...validCorrection(), to: undefined }],
    ['regra desconhecida', { ...validCorrection(), fromRule: 'chute' }],
    ['confiança acima de 1', { ...validCorrection(), fromConfidence: 1.5 }],
    ['confiança não-número', { ...validCorrection(), fromConfidence: 'alta' }]
  ])('recusa %s', (_name, payload) => {
    expect(() => parseCorrection(payload)).toThrow(/Correção da Central/)
  })
})
