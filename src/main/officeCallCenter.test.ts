import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAppMcpServer } from './appTools'
import { htmlTitle, OfficeCallCenter, parseCallsState } from './officeCallCenter'
import { emitOfficeCall, setOfficeCallSink } from './officeCallRuntime'

const notice = { id: 'toolu_1', convId: 'c1', cwd: 'C:\\proj\\loja', path: 'C:\\proj\\loja\\mockups\\vitrine.html', mensagem: 'olha', at: 5 }

function setup(head = '<html><head><title>Vitrine &amp; Ofertas</title></head></html>') {
  const bridge = { call: vi.fn(), resolved: vi.fn() }
  const notify = vi.fn()
  const open = vi.fn()
  const center = new OfficeCallCenter({ bridge, notify, open, readHead: async () => head })
  return { center, bridge, notify, open }
}

describe('os avisos do chamado no main (OfficeCallCenter)', () => {
  it('monta o aviso (agente pelo título da conversa, projeto, arquivo relativo, <title>), avisa a ponte e notifica; o clique abre a TV', async () => {
    const s = setup()
    s.center.state({ open: [], ended: [], watching: false, titles: { c1: 'Loja — vitrine' } })
    const e = await s.center.add(notice)
    expect(e).toEqual({ id: 'toolu_1', convId: 'c1', agente: 'Loja — vitrine', projeto: 'loja', arquivo: 'mockups/vitrine.html', titulo: 'Vitrine & Ofertas', mensagem: 'olha', at: 5 })
    expect(s.bridge.call).toHaveBeenCalledWith(e)
    expect(s.notify).toHaveBeenCalledTimes(1)
    s.notify.mock.calls[0][1]()
    expect(s.open).toHaveBeenCalledWith(e)
  })

  it('não notifica quem está olhando a sala de reunião (a ponte avisa igual); sem <title>, o nome do arquivo; o fim vai para a ponte', async () => {
    const s = setup('<p>sem título</p>')
    s.center.state({ open: [], ended: [], watching: true, titles: {} })
    const e = await s.center.add({ ...notice, mensagem: null })
    expect(e).toMatchObject({ agente: 'Agente', titulo: 'vitrine.html' })
    expect(e).not.toHaveProperty('mensagem')
    expect(s.notify).not.toHaveBeenCalled()
    expect(s.bridge.call).toHaveBeenCalledTimes(1)
    s.center.state({ open: [], ended: [{ id: 'toolu_1', motivo: 'respondido' }], watching: false, titles: {} })
    expect(s.bridge.resolved).toHaveBeenCalledWith({ id: 'toolu_1', motivo: 'respondido' })
  })

  it('htmlTitle e a validação do estado vindo do renderer', () => {
    expect(htmlTitle('<TITLE lang="pt">  Painel\n de vendas </TITLE>')).toBe('Painel de vendas')
    expect(htmlTitle('<title></title>')).toBeNull()
    expect(parseCallsState(null)).toBeNull()
    expect(parseCallsState({ open: 'x', ended: [], watching: false })).toBeNull()
    expect(parseCallsState({ open: ['a', 3], ended: [{ id: 'b', motivo: 'aberto' }, { id: 'c', motivo: 'sei lá' }], watching: true, titles: { c1: 'T', c2: 5 } })).toEqual({
      open: ['a'],
      ended: [{ id: 'b', motivo: 'aberto' }],
      watching: true,
      titles: { c1: 'T' }
    })
  })
})

describe('do handler da ferramenta à notificação', () => {
  it('app_chamar_usuario aceito → sink do main → ponte + notificação (Notification falsa)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'call-notify-'))
    writeFileSync(path.join(dir, 'tela.html'), '<title>Tela de login</title>')
    const s = setup('<title>Tela de login</title>')
    const done = new Promise<void>((resolve) => s.notify.mockImplementation(() => resolve()))
    setOfficeCallSink((n) => void s.center.add(n))
    const server = createAppMcpServer({ cwd: dir, callId: () => 'toolu_9', onCall: (c) => emitOfficeCall({ id: c.id ?? 'x', convId: 'c9', cwd: dir, path: c.path, mensagem: c.mensagem, at: 1 }) })
    const tool = (server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance._registeredTools.app_chamar_usuario
    await tool.handler({ arquivo: 'tela.html' }, {})
    await done
    expect(s.bridge.call).toHaveBeenCalledWith(expect.objectContaining({ id: 'toolu_9', convId: 'c9', arquivo: 'tela.html', titulo: 'Tela de login' }))
    expect(s.notify).toHaveBeenCalledTimes(1)
    setOfficeCallSink(null)
    rmSync(dir, { recursive: true, force: true })
  })
})
