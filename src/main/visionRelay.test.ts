import { describe, it, expect, vi } from 'vitest'

const queryMock = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args)
}))

import { describeImages, buildVisualContextBlock, mergeUserTextWithVisualContext } from './visionRelay'

/** Fakes the SDK's async-iterable Query: yields the given assistant text blocks. */
function fakeQuery(texts: string[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => {
          if (i >= texts.length) return { done: true, value: undefined }
          const text = texts[i++]
          return { done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }
        }
      }
    }
  }
}

describe('describeImages (vision_fallback_router)', () => {
  it('chama query() com o modelo multimodal, sem ferramentas, e devolve o texto da análise', async () => {
    queryMock.mockReturnValueOnce(fakeQuery(['Texto visível (OCR completo): Erro 404\nErros encontrados: página não encontrada']))

    const result = await describeImages([{ mediaType: 'image/png', data: 'AAAA' }], 'o que é esse erro?')

    expect(result).toContain('OCR completo')
    expect(queryMock).toHaveBeenCalledTimes(1)
    const call = queryMock.mock.calls[0][0] as { options: { model: string; tools: unknown; maxTurns: number; settings: unknown } }
    expect(call.options.model).toBe('claude-sonnet-5')
    expect(call.options.tools).toEqual([])
    expect(call.options.maxTurns).toBe(1)
    expect(call.options.settings).toEqual({ autoMemoryEnabled: false })
  })

  it('concatena múltiplos blocos de texto do stream', async () => {
    queryMock.mockReturnValueOnce(fakeQuery(['parte 1. ', 'parte 2.']))
    const result = await describeImages([{ mediaType: 'image/png', data: 'AAAA' }], '')
    expect(result).toBe('parte 1. parte 2.')
  })
})

describe('buildVisualContextBlock / mergeUserTextWithVisualContext', () => {
  it('envolve a análise em [VISUAL_CONTEXT]...[/VISUAL_CONTEXT]', () => {
    expect(buildVisualContextBlock('foo')).toBe('[VISUAL_CONTEXT]\nfoo\n[/VISUAL_CONTEXT]')
  })

  it('monta a mensagem final com o texto original + o bloco visual', () => {
    const merged = mergeUserTextWithVisualContext('o que é isso?', 'descrição da imagem')
    expect(merged).toContain('Mensagem original do usuário:\no que é isso?')
    expect(merged).toContain('[VISUAL_CONTEXT]\ndescrição da imagem\n[/VISUAL_CONTEXT]')
    expect(merged).toContain('Agora responda considerando a análise visual acima.')
  })

  it('mensagem sem texto ainda funciona (só imagem)', () => {
    const merged = mergeUserTextWithVisualContext('', 'descrição')
    expect(merged).toContain('(sem texto — apenas a(s) imagem(ns) anexada(s))')
  })
})
