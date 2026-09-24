// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import {
  sanitizeTitle,
  suggestConversationTitle,
  TITLE_INPUT_MAX_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MODEL,
  type TitleQuery
} from './conversationTitle'

type Call = { prompt: AsyncIterable<unknown>; options: Options }

function assistant(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra }
}

/** Um `query` falso que devolve as mensagens dadas e guarda a chamada. */
function fakeQuery(messages: unknown[]): { run: TitleQuery; calls: Call[] } {
  const calls: Call[] = []
  const run: TitleQuery = (args) => {
    calls.push(args as Call)
    return (async function* () {
      for (const m of messages) yield m
    })()
  }
  return { run, calls }
}

async function promptText(call: Call): Promise<string> {
  let out = ''
  for await (const m of call.prompt) {
    const content = (m as { message: { content: Array<{ text: string }> } }).message.content
    out += content.map((c) => c.text).join('')
  }
  return out
}

describe('suggestConversationTitle', () => {
  it('sucesso: devolve o título do Haiku, one-shot, sem effort e sem thinking', async () => {
    const { run, calls } = fakeQuery([assistant('Checkout com Pix'), { type: 'result', is_error: false }])
    const title = await suggestConversationTitle('quero montar o checkout com pix na loja', { query: run })
    expect(title).toBe('Checkout com Pix')
    expect(calls).toHaveLength(1)
    const { options } = calls[0]
    expect(options.model).toBe(TITLE_MODEL)
    expect(TITLE_MODEL).toBe('claude-haiku-4-5')
    expect(options).not.toHaveProperty('effort')
    expect(options.thinking).toEqual({ type: 'disabled' })
    expect(options).not.toHaveProperty('maxThinkingTokens')
    expect(options.tools).toEqual([])
    expect(options.maxTurns).toBe(1)
    expect(options.persistSession).toBe(false)
    expect(options.settings).toEqual({ autoMemoryEnabled: false })
    expect(options.abortController).toBeInstanceOf(AbortController)
    expect(await promptText(calls[0])).toContain('quero montar o checkout com pix na loja')
  })

  it('texto vazio nem chama o modelo', async () => {
    const { run, calls } = fakeQuery([assistant('x')])
    expect(await suggestConversationTitle('   \n ', { query: run })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('corta a mensagem em TITLE_INPUT_MAX_CHARS antes de mandar', async () => {
    const { run, calls } = fakeQuery([assistant('Algo')])
    await suggestConversationTitle(`${'a'.repeat(TITLE_INPUT_MAX_CHARS)}FIM`, { query: run })
    const sent = await promptText(calls[0])
    expect(sent).not.toContain('FIM')
    expect(sent).toContain('a'.repeat(TITLE_INPUT_MAX_CHARS))
  })

  it('lixo, aspas, emoji e texto longo saem sanitizados', async () => {
    const { run } = fakeQuery([
      assistant('\n\nTítulo: "Migração do banco para Postgres com réplicas e failover automático." 🚀\nExplicação: ...')
    ])
    const title = await suggestConversationTitle('migra o banco', { query: run })
    expect(title).not.toBeNull()
    expect(title!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(title).toBe('Migração do banco para Postgres com')
    expect(title).not.toMatch(/["“”🚀\n]|\.$/u)
  })

  it('resposta sem nada aproveitável vira null', async () => {
    const { run } = fakeQuery([assistant('  "" 🎉 ... ')])
    expect(await suggestConversationTitle('oi', { query: run })).toBeNull()
  })

  it('erro classificado pelo SDK (assistant.error) ou result com is_error vira null', async () => {
    const a = fakeQuery([assistant('API Error: 400 effort not supported', { error: 'invalid_request' })])
    expect(await suggestConversationTitle('oi', { query: a.run })).toBeNull()
    const b = fakeQuery([assistant('Parcial'), { type: 'result', is_error: true }])
    expect(await suggestConversationTitle('oi', { query: b.run })).toBeNull()
  })

  it('exceção do query (lançada ou no meio do stream) vira null, sem lançar', async () => {
    const throwsNow: TitleQuery = () => {
      throw new Error('spawn node ENOENT')
    }
    expect(await suggestConversationTitle('oi', { query: throwsNow })).toBeNull()
    const throwsLater: TitleQuery = () =>
      (async function* () {
        yield assistant('Meio')
        throw new Error('processo morreu')
      })()
    expect(await suggestConversationTitle('oi', { query: throwsLater })).toBeNull()
  })

  it('timeout: aborta a chamada e devolve null', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const hangs: TitleQuery = ({ options }) => {
        signal = options.abortController?.signal
        return (async function* () {
          await new Promise(() => {}) // nunca responde
          yield assistant('tarde demais')
        })()
      }
      const pending = suggestConversationTitle('oi', { query: hangs, timeoutMs: 12_000 })
      await vi.advanceTimersByTimeAsync(11_999)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toBeNull()
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sanitizeTitle', () => {
  it('primeira linha não vazia, sem prefixo, markdown, aspas nem ponto final', () => {
    expect(sanitizeTitle('\n  **Título:** “Login com SSO”.\nmais texto')).toBe('Login com SSO')
    expect(sanitizeTitle('# Deploy no Vercel…')).toBe('Deploy no Vercel')
    expect(sanitizeTitle("'Cache de sessão'")).toBe('Cache de sessão')
    expect(sanitizeTitle('- Title: Refatorar o parser')).toBe('Refatorar o parser')
  })

  it('tira emoji (inclusive sequências com ZWJ) e junta espaços', () => {
    expect(sanitizeTitle('🧑‍💻  Ajuste   de CI ✅')).toBe('Ajuste de CI')
  })

  it('corta em 40 na palavra inteira quando dá; senão corta seco', () => {
    const t = sanitizeTitle('Configurar pipeline de integração contínua no GitHub Actions')!
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(t).toBe('Configurar pipeline de integração')
    expect(sanitizeTitle('x'.repeat(60))).toBe('x'.repeat(TITLE_MAX_CHARS))
  })

  it('mantém apóstrofo no meio da palavra e interrogação no fim', () => {
    expect(sanitizeTitle("Caixa d'água no mapa")).toBe("Caixa d'água no mapa")
    expect(sanitizeTitle('Por que o build quebra?')).toBe('Por que o build quebra?')
  })

  it('vazio → null', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   ...  ')).toBeNull()
  })
})
