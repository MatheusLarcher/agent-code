import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { TOOL_CODE_MAX, TOOL_RESULT_MAX } from './toolDescribe'
import type { ToolUseMessage } from './ToolCard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const tts = { speakingId: null, onToggleSpeak: () => {} }
const tool = (over: Partial<ToolUseMessage>): ToolUseMessage => ({ kind: 'tool-use', id: 't1', name: 'Bash', input: {}, parentToolUseId: null, ...over }) as ToolUseMessage

function renderChat(...messages: ToolUseMessage[]): HTMLElement[] {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  render(
    <UiProvider>
      <MessageList messages={messages} busy={false} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
  return [...document.querySelectorAll<HTMLElement>('.tool-card')]
}

describe('ToolCard no chat (o cartão compartilhado com o Escritório 3D)', () => {
  it('cabeçalho: verbo, detalhe, +N −M e a pílula (running… / done / error); erro pinta o cartão', () => {
    const [bash, edit, read] = renderChat(
      tool({ id: 'a', input: { command: 'npm test\n--watch' } }),
      tool({ id: 'b', name: 'Edit', input: { file_path: 'C:/p/a.ts', old_string: 'a\nb', new_string: 'c' }, result: { isError: true, text: 'falhou' } }),
      tool({ id: 'c', name: 'Read', input: { file_path: '/p/c.ts' }, result: { isError: false, text: 'ok' } })
    )
    expect(bash.querySelector('.tool-name')?.textContent).toBe('Bash')
    expect(bash.querySelector('.tool-detail')?.textContent).toBe('npm test')
    expect(bash.querySelector('.tool-badge')?.className).toBe('tool-badge run')
    expect(bash.querySelector('.tool-badge')?.textContent).toBe('running…')
    expect(edit.classList.contains('tool-error')).toBe(true)
    expect(edit.querySelector('.tool-diff')?.textContent).toBe('+1−2')
    expect(edit.querySelector('.tool-badge')?.textContent).toBe('error')
    expect(read.classList.contains('tool-error')).toBe(false)
    expect(read.querySelector('.tool-badge')?.className).toBe('tool-badge ok')
  })

  it('pergunta ao usuário: nunca vermelha — "respondido" ou "sem resposta"', () => {
    const [answered, expired] = renderChat(
      tool({ id: 'q1', name: 'AskUserQuestion', input: { questions: [{ header: 'Banco' }] }, result: { isError: true, text: 'Usuário respondeu: X' } }),
      tool({ id: 'q2', name: 'AskUserQuestion', input: { questions: [] }, result: { isError: true, text: 'O usuário não respondeu a tempo' } })
    )
    expect(answered.classList.contains('tool-error')).toBe(false)
    expect(answered.querySelector('.tool-name')?.textContent).toBe('Pergunta')
    expect(answered.querySelector('.tool-badge')?.textContent).toBe('respondido')
    expect(expired.querySelector('.tool-badge')?.textContent).toBe('sem resposta')
  })

  it('aberto: entrada legível e resultado, nos limites do chat', () => {
    const [card] = renderChat(tool({ input: { command: 'x'.repeat(TOOL_CODE_MAX + 50) }, result: { isError: false, text: 'y'.repeat(TOOL_RESULT_MAX + 50) } }))
    fireEvent.click(card.querySelector('.tool-head')!)
    expect(card.querySelector('.code-block')?.textContent?.length).toBe(TOOL_CODE_MAX)
    expect(card.querySelector('.tool-result-pre')?.textContent?.length).toBe(TOOL_RESULT_MAX)
  })

  it('Write: Preview abre a aba de arquivo (file:///, barras normalizadas); entregável ganha o Baixar', async () => {
    const newTab = vi.fn(async () => 'aberta')
    const downloadFile = vi.fn(async () => ({ ok: true, message: 'salvo' }))
    ;(window as unknown as { api: unknown }).api = { newTab, downloadFile }
    const [md, pdf] = renderChat(
      tool({ id: 'w1', name: 'Write', input: { file_path: 'C:/p/notas.md', content: 'oi' }, result: { isError: false, text: 'ok' } }),
      tool({ id: 'w2', name: 'Write', input: { file_path: '/p/rel.pdf', content: 'pdf' }, result: { isError: false, text: 'ok' } })
    )
    fireEvent.click(md.querySelector('.tool-download')!)
    expect(newTab).toHaveBeenCalledWith('file', 'file:///C:/p/notas.md')
    fireEvent.click(screen.getByTitle('Baixar arquivo'))
    expect(downloadFile).toHaveBeenCalledWith('/p/rel.pdf')
    expect(pdf.querySelector('.tool-download')?.textContent).toBe('⬇️ Baixar')
  })
})
