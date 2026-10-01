import { describe, expect, it, vi } from 'vitest'
import { LiveInputStore, type ToolInputDelta } from './liveInput'

const ev = (toolUseId: string, newText: string, done = false): ToolInputDelta => ({
  kind: 'tool-input-delta',
  toolUseId,
  name: 'Write',
  filePath: '/a.ts',
  newText,
  totalLines: newText ? newText.split('\n').length : 0,
  done
})

describe('LiveInputStore', () => {
  it('sem assinante descarta na hora e não guarda nada', () => {
    const store = new LiveInputStore()
    store.push('c1', ev('t1', 'a'))
    expect(store.latest('c1', 't1')).toBeUndefined()
    expect(store.latest('c1', null)).toBeUndefined()
    // Quem assina depois não recebe o que passou com a tela fechada.
    const cb = vi.fn()
    store.subscribe('c1', null, cb)
    expect(cb).not.toHaveBeenCalled()
    expect(store.latest('c1', 't1')).toBeUndefined()
  })

  it('com assinante entrega e guarda só o último evento de cada bloco', () => {
    const store = new LiveInputStore()
    const cb = vi.fn()
    store.subscribe('c1', null, cb)
    store.push('c1', ev('t1', 'a'))
    store.push('c1', ev('t1', 'a\nb'))
    store.push('c1', ev('t2', 'x'))
    expect(cb).toHaveBeenCalledTimes(3)
    expect(store.latest('c1', 't1')?.newText).toBe('a\nb')
    expect(store.latest('c1', null)?.toolUseId).toBe('t2')
  })

  it('o done entrega e limpa o bloco', () => {
    const store = new LiveInputStore()
    const cb = vi.fn()
    store.subscribe('c1', null, cb)
    store.push('c1', ev('t1', 'a'))
    store.push('c1', ev('t1', 'a\nb', true))
    expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({ done: true, newText: 'a\nb' }))
    expect(store.latest('c1', 't1')).toBeUndefined()
    expect(store.latest('c1', null)).toBeUndefined()
  })

  it('filtra por conversa e por toolUseId', () => {
    const store = new LiveInputStore()
    const onlyT1 = vi.fn()
    const otherConv = vi.fn()
    store.subscribe('c1', 't1', onlyT1)
    store.subscribe('c2', null, otherConv)
    store.push('c1', ev('t1', 'a'))
    store.push('c1', ev('t2', 'b'))
    expect(onlyT1).toHaveBeenCalledTimes(1)
    expect(onlyT1).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 't1' }))
    expect(otherConv).not.toHaveBeenCalled()
    // c2 tem assinante, mas nada chegou para ela.
    expect(store.latest('c2', null)).toBeUndefined()
  })

  it('o último assinante a sair leva o que estava guardado, e volta a descartar', () => {
    const store = new LiveInputStore()
    const a = store.subscribe('c1', null, vi.fn())
    const b = store.subscribe('c1', 't1', vi.fn())
    store.push('c1', ev('t1', 'a'))
    a()
    expect(store.latest('c1', 't1')?.newText).toBe('a')
    b()
    expect(store.latest('c1', 't1')).toBeUndefined()
    store.push('c1', ev('t1', 'depois'))
    expect(store.latest('c1', 't1')).toBeUndefined()
    // Cancelar de novo não quebra nada.
    b()
  })

  it('um assinante que falha ou cancela no callback não atrapalha os outros', () => {
    const store = new LiveInputStore()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const off = store.subscribe('c1', null, () => {
      seen.push('primeiro')
      off()
      throw new Error('painel quebrado')
    })
    store.subscribe('c1', null, () => seen.push('segundo'))
    store.push('c1', ev('t1', 'a'))
    expect(seen).toEqual(['primeiro', 'segundo'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
