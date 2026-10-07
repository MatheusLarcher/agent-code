import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { TOOL_CODE_MAX, TOOL_RESULT_MAX } from './toolDescribe'
import type { ToolUseMessage } from './ToolCard'
import { ToolFileOpenContext, type ToolFileOpen } from './toolFileOpen'
import { openSteps } from './chatStepsTestkit'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const tts = { speakingId: null, onToggleSpeak: () => {} }
const tool = (over: Partial<ToolUseMessage>): ToolUseMessage => ({ kind: 'tool-use', id: 't1', name: 'Bash', input: {}, parentToolUseId: null, ...over }) as ToolUseMessage

function renderChat(...messages: ToolUseMessage[]): HTMLElement[] {
  return renderWith(null, ...messages)
}

/** Com `opener`, como o Chat do monitor do Escritório (o editor ao lado); null = a aba Conversa. */
function renderWith(opener: ToolFileOpen | null, ...messages: ToolUseMessage[]): HTMLElement[] {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  render(
    <UiProvider>
      <ToolFileOpenContext.Provider value={opener}>
        <MessageList messages={messages} busy={false} tts={tts} onRetry={() => {}} />
      </ToolFileOpenContext.Provider>
    </UiProvider>
  )
  openSteps()
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

  it('sem quem abra arquivos (a aba Conversa): o cabeçalho é um botão só, que expande — também no cartão de arquivo', () => {
    const [edit] = renderChat(tool({ id: 'e', name: 'Edit', input: { file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' }, result: { isError: false, text: 'ok' } }))
    expect(edit.classList.contains('tool-file')).toBe(false)
    expect(edit.querySelector('.tool-head-split')).toBeNull()
    expect(edit.querySelectorAll('button')).toHaveLength(1)
    expect(edit.querySelector('.tool-head')?.tagName).toBe('BUTTON')
    expect(edit.querySelector('.tool-head')?.firstElementChild?.className).toBe('tool-caret')
    fireEvent.click(edit.querySelector('.tool-head')!)
    expect(edit.querySelector('.tool-body')).toBeTruthy()
  })
})

describe('ToolCard com o editor ao lado (o Chat do monitor do Escritório)', () => {
  const editA = tool({ id: 'e', name: 'Edit', input: { file_path: 'C:/p/a.ts', old_string: 'a', new_string: 'b' }, result: { isError: false, text: 'ok' } })
  const readB = tool({ id: 'r', name: 'Read', input: { file_path: 'C:/p/b.ts' }, result: { isError: false, text: 'ok' } })
  const bash = tool({ id: 'b', input: { command: 'npm test' }, result: { isError: false, text: 'ok' } })

  it('cartão de arquivo: o cabeçalho abre no editor (sem expandir); a ▸ só expande (sem abrir)', () => {
    const open = vi.fn()
    const [edit, read] = renderWith({ open }, editA, readB)
    expect(edit.classList.contains('tool-file')).toBe(true)
    const opener = edit.querySelector<HTMLElement>('.tool-open')!
    expect(opener.getAttribute('title')).toBe('Abrir no editor')
    expect(opener.querySelector('.tool-detail')?.textContent).toBe('a.ts')
    expect(opener.querySelector('.tool-go')).toBeTruthy()
    fireEvent.click(opener)
    expect(open).toHaveBeenCalledWith(editA)
    expect(edit.querySelector('.tool-body')).toBeNull()
    const caret = screen.getAllByRole('button', { name: 'Mostrar a entrada e o resultado' })[0]
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(edit.querySelector('.tool-body')).toBeTruthy()
    expect(caret.getAttribute('aria-expanded')).toBe('true')
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(read.querySelector('.tool-open')!)
    expect(open).toHaveBeenLastCalledWith(readB)
  })

  it('cartão que não é de arquivo (Bash): o de sempre — o cabeçalho só expande', () => {
    const open = vi.fn()
    const [card] = renderWith({ open }, bash)
    expect(card.classList.contains('tool-file')).toBe(false)
    expect(card.querySelector('.tool-open')).toBeNull()
    fireEvent.click(card.querySelector('.tool-head')!)
    expect(card.querySelector('.tool-body')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })
})
