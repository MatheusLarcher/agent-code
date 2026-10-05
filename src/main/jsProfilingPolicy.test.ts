// @vitest-environment node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installJsProfilingPolicy, rendererIndexMatcher, type HeadersSession } from './jsProfilingPolicy'

type Listener = Parameters<HeadersSession['webRequest']['onHeadersReceived']>[1]

function fakeSession(): { session: HeadersSession; filter: () => { urls: string[] } | null; run: (details: Parameters<Listener>[0]) => unknown } {
  let listener: Listener | null = null
  let filter: { urls: string[] } | null = null
  const session: HeadersSession = {
    webRequest: {
      onHeadersReceived: (f, l) => {
        filter = f
        listener = l
      }
    }
  }
  return {
    session,
    filter: () => filter,
    run: (details) => {
      const callback = vi.fn()
      listener?.(details, callback)
      expect(callback).toHaveBeenCalledTimes(1)
      return callback.mock.calls[0][0]
    }
  }
}

const INDEX = join(process.cwd(), 'out', 'renderer', 'index.html')
const INDEX_URL = pathToFileURL(INDEX).href

describe('jsProfilingPolicy', () => {
  it('só o mainFrame do index do renderer ganha Document-Policy: js-profiling; o resto passa inalterado', () => {
    const fake = fakeSession()
    installJsProfilingPolicy(fake.session, rendererIndexMatcher(INDEX))
    expect(fake.filter()).toEqual({ urls: ['file:///*'] })
    const headers = { 'Content-Type': ['text/html'] }
    expect(fake.run({ url: INDEX_URL, resourceType: 'mainFrame', responseHeaders: headers })).toEqual({
      responseHeaders: { 'Content-Type': ['text/html'], 'Document-Policy': ['js-profiling'] }
    })
    // Sem cabeçalhos na resposta (file:// costuma vir assim).
    expect(fake.run({ url: INDEX_URL, resourceType: 'mainFrame' })).toEqual({ responseHeaders: { 'Document-Policy': ['js-profiling'] } })
    // Script do próprio renderer, iframe com o index, outro html, URL inválida: inalterados.
    const assetUrl = pathToFileURL(join(process.cwd(), 'out', 'renderer', 'assets', 'index.js')).href
    expect(fake.run({ url: assetUrl, resourceType: 'script', responseHeaders: headers })).toEqual({})
    expect(fake.run({ url: INDEX_URL, resourceType: 'subFrame', responseHeaders: headers })).toEqual({})
    expect(fake.run({ url: pathToFileURL(join(process.cwd(), 'mockup.html')).href, resourceType: 'mainFrame' })).toEqual({})
    expect(fake.run({ url: 'file://%%%', resourceType: 'mainFrame' })).toEqual({})
  })

  it('o matcher ignora query/hash e, no Windows, maiúsculas', () => {
    const win = rendererIndexMatcher('C:\\App\\out\\renderer\\index.html', 'win32')
    if (process.platform === 'win32') {
      expect(win('file:///c:/app/OUT/renderer/index.html?x=1#y')).toBe(true)
      expect(win('file:///C:/App/out/renderer/other.html')).toBe(false)
    }
    const same = rendererIndexMatcher(INDEX)
    expect(same(`${INDEX_URL}#/chat`)).toBe(true)
    expect(same('https://exemplo.com/index.html')).toBe(false)
  })

  it('matcher que lança não derruba a requisição', () => {
    const fake = fakeSession()
    installJsProfilingPolicy(fake.session, () => {
      throw new Error('x')
    })
    expect(fake.run({ url: INDEX_URL, resourceType: 'mainFrame' })).toEqual({})
  })
})
