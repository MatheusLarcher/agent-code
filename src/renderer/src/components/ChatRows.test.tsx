import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ChatRow, lastAnswerTsId, rowKey, type ChatRowContext } from './ChatRows'

afterEach(cleanup)

const failed: UIMessage = { kind: 'user', id: 'u1', text: 'arruma o login', error: 'API sobrecarregada (529)' }
const answer: UIMessage = { kind: 'assistant-text', id: 'a1', text: 'Pronto: **login** arrumado.', final: true, answer: true, ts: Date.now() }
const card: UIMessage = { kind: 'tool-use', id: 't1', name: 'Edit', input: { file_path: 'C:\\p\\login.ts', old_string: 'a', new_string: 'b\nc' }, parentToolUseId: null, result: { isError: false, text: 'ok' } }

function rows(ctx: ChatRowContext, messages: UIMessage[] = [failed, answer, card]): HTMLElement {
  return render(
    <UiProvider>
      <div>
        {messages.map((m, i) => (
          <ChatRow key={rowKey(m, i)} m={m} ctx={ctx} />
        ))}
      </div>
    </UiProvider>
  ).container
}

describe('ChatRow: as linhas do chat, também só leitura', () => {
  it('com os ganchos do chat: "Tentar de novo", "Ouvir" e a hora da última resposta', () => {
    const onRetry = vi.fn()
    const el = rows({ resolveRef: null, lastTsId: 'a1', onRetry, tts: { speakingId: null, onToggleSpeak: vi.fn() } })
    fireEvent.click(el.querySelector('.msg-retry')!)
    expect(onRetry).toHaveBeenCalledWith('u1')
    expect(el.querySelector('.msg-speak')?.textContent).toContain('Ouvir')
    expect(el.querySelector('.msg.assistant .msg-time')).toBeTruthy()
  })

  it('só leitura (o Escritório): o mesmo balão, o mesmo Markdown e o mesmo cartão, sem "Tentar de novo" nem "Ouvir"', () => {
    const el = rows({ resolveRef: null, lastTsId: 'a1' })
    expect(el.querySelector('.msg.user .bubble.has-error')?.textContent).toBe('arruma o login')
    expect(el.querySelector('.msg-error-text')?.textContent).toContain('API sobrecarregada (529)')
    expect(el.querySelector('.msg-retry')).toBeNull()
    expect(el.querySelector('.msg.assistant .md strong')?.textContent).toBe('login')
    expect(el.querySelector('.msg-speak')).toBeNull()
    expect(el.querySelector('.msg.assistant .msg-time')).toBeTruthy()
    const tool = el.querySelector('.tool-card')!
    expect(tool.querySelector('.tool-name')?.textContent).toBe('Edit')
    expect(tool.querySelector('.diff-add')?.textContent).toBe('+2')
    expect(tool.querySelector('.tool-body')).toBeNull()
    fireEvent.click(tool.querySelector('.tool-head')!)
    expect(tool.querySelector('.tool-body')).toBeTruthy()
  })

  it('a chave e a hora da última resposta são as do chat', () => {
    expect([failed, answer, card].map((m, i) => rowKey(m, i))).toEqual(['user:u1', 'assistant:a1', 'tool:t1'])
    expect(rowKey({ kind: 'system', sessionId: 's', model: 'm', cwd: 'c', tools: [] }, 7)).toBe('system:s:7')
    expect(lastAnswerTsId([answer, { ...answer, id: 'a2', ts: undefined }])).toBe('a1')
    expect(lastAnswerTsId([failed])).toBeNull()
  })
})
