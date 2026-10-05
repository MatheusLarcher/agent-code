import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_KEY, DEVICE_KEY, configFromLocation, deviceId, deviceName, loadConfig, parseConfig, saveConfig } from './config'
import { apiUrl, errorText, HttpError, pickBestBase } from './net'
import { isHiddenMessage, reduce, syncQueued } from './reducer'
import { fmtReset, parseDownloads, readableMedia } from './format'
import type { ChatMsg } from './types'

describe('config (pareamento salvo)', () => {
  beforeEach(() => localStorage.clear())

  it('lê o QR público com token e LAN', () => {
    expect(parseConfig('https://agent-code.larchertech.com/?token=ab12&lan=192.168.0.10%3A8765')).toEqual({
      base: 'https://agent-code.larchertech.com',
      token: 'ab12',
      lan: '192.168.0.10:8765'
    })
  })

  it('QR antigo só com a URL da LAN; texto que não é URL não pareia', () => {
    expect(parseConfig('http://192.168.0.10:8765/?token=x')).toEqual({ base: 'http://192.168.0.10:8765', token: 'x', lan: '' })
    expect(parseConfig('qualquer coisa').base).toBe('')
  })

  it('mantém as chaves do app antigo (quem atualiza o APK continua pareado e com o mesmo id)', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ base: 'http://1.2.3.4:8765', token: 't' }))
    expect(loadConfig()).toEqual({ base: 'http://1.2.3.4:8765', token: 't', lan: '' })
    localStorage.setItem(DEVICE_KEY, 'ph-antigo')
    expect(deviceId()).toBe('ph-antigo')
    saveConfig({ base: 'b', token: 'k', lan: 'l' })
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual({ base: 'b', token: 'k', lan: 'l' })
  })

  it('config corrompida não derruba o app', () => {
    localStorage.setItem(CONFIG_KEY, '{nope')
    expect(loadConfig()).toBeNull()
  })

  it('no navegador, /app/?token= da própria ponte vira o pareamento; no WebView (localhost) não', () => {
    expect(configFromLocation({ protocol: 'http:', host: '192.168.0.10:8765', search: '?token=abc' })).toEqual({ base: 'http://192.168.0.10:8765', token: 'abc', lan: '' })
    expect(configFromLocation({ protocol: 'http:', host: 'localhost', search: '?token=abc' })).toBeNull()
    expect(configFromLocation({ protocol: 'http:', host: '192.168.0.10:8765', search: '' })).toBeNull()
  })

  it('nome do aparelho pelo user agent', () => {
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit')).toBe('SM-S928B')
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; pt-br) AppleWebKit')).toBe('celular')
  })
})

describe('rede', () => {
  it('URL com token e identidade do aparelho', () => {
    expect(apiUrl({ base: 'http://pc:8765', token: 't k', dev: 'ph-1', devName: 'Galaxy S' }, '/api/history?conv=c1')).toBe(
      'http://pc:8765/api/history?conv=c1&token=t%20k&dev=ph-1&devname=Galaxy%20S'
    )
  })

  it('prefere a LAN quando ela responde; senão o relay; sem LAN nem sonda', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    expect(await pickBestBase('https://vps', '10.0.0.2:8765', 'tok', probe)).toBe('http://10.0.0.2:8765')
    expect(probe).toHaveBeenCalledWith('http://10.0.0.2:8765/api/state?token=tok', 1200)
    expect(await pickBestBase('https://vps', '10.0.0.2:8765', 'tok', vi.fn().mockResolvedValue(false))).toBe('https://vps')
    const none = vi.fn()
    expect(await pickBestBase('https://vps', '', 'tok', none)).toBe('https://vps')
    expect(none).not.toHaveBeenCalled()
  })

  it('mensagem humana por status (503 = PC fora do relay, 401 = token, 0 = rede)', () => {
    expect(errorText(new HttpError(503))).toMatch(/não está conectado/)
    expect(errorText(new HttpError(401))).toMatch(/token/)
    expect(errorText(new HttpError(0))).toMatch(/Sem conexão/)
    expect(errorText(new Error('x'))).toMatch(/Sem conexão/)
  })
})

describe('redutor do feed', () => {
  const tool = (id: string, extra: Record<string, unknown> = {}): ChatMsg =>
    ({ kind: 'tool-use', id, name: 'Read', input: {}, parentToolUseId: null, ...extra }) as ChatMsg

  it('texto em streaming substitui pelo id; resultado acopla na ferramenta; result marca a resposta', () => {
    let list: ChatMsg[] = []
    list = reduce(list, { kind: 'assistant-text', id: 'a', text: 'Ol', final: false })
    list = reduce(list, { kind: 'assistant-text', id: 'a', text: 'Olá', final: true })
    list = reduce(list, tool('t1'))
    list = reduce(list, { kind: 'tool-result', id: 'r', toolUseId: 't1', isError: false, text: 'ok' })
    list = reduce(list, { kind: 'result', id: 'x', isError: false, text: '', durationMs: 1 })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ text: 'Olá', answer: true })
    expect(list[1]).toMatchObject({ result: { isError: false, text: 'ok' } })
  })

  it('não muta a lista anterior (o React compara por referência)', () => {
    const before: ChatMsg[] = [{ kind: 'assistant-text', id: 'a', text: 'x', final: false }]
    const after = reduce(before, { kind: 'assistant-text', id: 'a', text: 'xy', final: false })
    expect(after).not.toBe(before)
    expect(before[0]).toMatchObject({ text: 'x' })
  })

  it('subagente, plano e estado nunca entram no feed', () => {
    const list: ChatMsg[] = []
    expect(reduce(list, tool('s', { parentToolUseId: 'task-1' }))).toBe(list)
    expect(reduce(list, tool('p', { name: 'TodoWrite' }))).toBe(list)
    expect(reduce(list, { kind: 'stall-status', stalled: true, since: 1 })).toBe(list)
    expect(isHiddenMessage({ kind: 'tool-use', name: 'TaskCreate' })).toBe(true)
    expect(isHiddenMessage({ kind: 'tool-use', name: 'Read', parentToolUseId: null })).toBe(false)
  })

  it('fila: some o que o PC já tirou, entra o que só o PC mostra', () => {
    const msgs: ChatMsg[] = [
      { kind: 'user', id: 'u1', text: 'enviada' },
      { kind: 'user', id: 'q1', text: 'na fila 1', queued: true },
      { kind: 'user', id: 'q2', text: 'já saiu', queued: true }
    ]
    const out = syncQueued(msgs, { queued: [{ text: 'na fila 1' }, { text: 'do PC' }] }, 5)
    expect(out.map((m) => (m as { text: string }).text)).toEqual(['enviada', 'na fila 1', 'do PC'])
    expect(out[2]).toMatchObject({ queued: true, id: 'queued-5-0' })
    const same = msgs.slice(0, 2)
    expect(syncQueued(same, { queued: [{ text: 'na fila 1' }] })).toBe(same) // nada mudou: mesma lista
  })
})

describe('formatação', () => {
  it('tira [[download:…]] do texto', () => {
    expect(parseDownloads('Pronto.\n\n[[download: C:\\a\\app.apk ]]\n\n\nFim')).toEqual({ clean: 'Pronto.\n\nFim', paths: ['C:\\a\\app.apk'] })
  })
  it('{{midia:N}} legível', () => {
    expect(readableMedia('veja {{midia:2}}')).toBe('veja [mídia 2]')
  })
  it('reset da janela em segundos ou ms', () => {
    expect(fmtReset(1000 + 30 * 60, 1000 * 1000)).toBe('reseta em 30 min')
    expect(fmtReset(5, 6000)).toBe('já resetou')
  })
})
