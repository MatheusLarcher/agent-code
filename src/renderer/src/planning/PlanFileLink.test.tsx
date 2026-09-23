import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatDisplayContext } from '../components/chatDisplay'
import { MessageList } from '../components/MessageList'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { HANDOFF_TOOL, createdPlanFile, isInsidePlan } from './PlanFileLink'

const PLAN = 'C:\\proj\\app/docs/spec/checkout'
const SANDBOX_FILE = 'C:\\proj\\app\\docs\\spec\\checkout\\_sandbox\\medir.ts'
const HANDOFF_FILE = 'C:\\proj\\app\\docs\\spec\\checkout\\_handoff\\2026-09-23-01.md'
const ok = (text = 'ok') => ({ isError: false, text })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('isInsidePlan', () => {
  it('aceita arquivo dentro da pasta do plano, com barra e caixa trocadas', () => {
    expect(isInsidePlan(SANDBOX_FILE, PLAN)).toBe(true)
    expect(isInsidePlan('c:/PROJ/app/docs/spec/checkout/_sandbox/a.txt', PLAN)).toBe(true)
  })

  it('recusa fora do plano, a própria pasta, `..` e caracteres que o shell interpretaria', () => {
    expect(isInsidePlan('C:\\proj\\app\\src\\index.ts', PLAN)).toBe(false)
    expect(isInsidePlan('C:\\proj\\app\\docs\\spec\\checkout-2\\x.md', PLAN)).toBe(false)
    expect(isInsidePlan(PLAN, PLAN)).toBe(false)
    expect(isInsidePlan('C:\\proj\\app\\docs\\spec\\checkout\\_sandbox\\..\\..\\..\\..\\x.bat', PLAN)).toBe(false)
    expect(isInsidePlan('C:\\proj\\app\\docs\\spec\\checkout\\_sandbox\\%PATH%.txt', PLAN)).toBe(false)
    expect(isInsidePlan('C:\\proj\\app\\docs\\spec\\checkout\\_sandbox\\a".txt', PLAN)).toBe(false)
  })
})

describe('createdPlanFile', () => {
  it('Write bem-sucedido no plano e handoff gravado contam', () => {
    expect(createdPlanFile('Write', { file_path: SANDBOX_FILE }, ok(), PLAN)).toBe(SANDBOX_FILE)
    expect(createdPlanFile(HANDOFF_TOOL, { conteudo: '# x' }, ok(`Handoff gravado em ${HANDOFF_FILE}`), PLAN)).toBe(
      HANDOFF_FILE
    )
  })

  it('não conta: fora do planejamento, Write que falhou, sem resultado, Edit e card', () => {
    expect(createdPlanFile('Write', { file_path: SANDBOX_FILE }, ok(), undefined)).toBeNull()
    expect(createdPlanFile('Write', { file_path: SANDBOX_FILE }, { isError: true, text: 'negado' }, PLAN)).toBeNull()
    expect(createdPlanFile('Write', { file_path: SANDBOX_FILE }, undefined, PLAN)).toBeNull()
    expect(createdPlanFile('Edit', { file_path: SANDBOX_FILE }, ok(), PLAN)).toBeNull()
    expect(createdPlanFile('mcp__planning__plan_card_create', { titulo: 'x' }, ok('Card criado: x'), PLAN)).toBeNull()
  })
})

describe('link no chat', () => {
  Element.prototype.scrollIntoView = vi.fn()
  const tts = { speakingId: null, onToggleSpeak: (): void => {} }
  const MESSAGES: UIMessage[] = [
    { kind: 'tool-use', id: 't1', name: 'Write', input: { file_path: SANDBOX_FILE, content: 'x' }, result: ok() },
    { kind: 'tool-use', id: 't2', name: HANDOFF_TOOL, input: { conteudo: '# plano' }, result: ok(`Handoff gravado em ${HANDOFF_FILE}`) }
  ] as UIMessage[]

  const renderList = (planDir?: string) =>
    render(
      <UiProvider>
        <ChatDisplayContext.Provider value={planDir ? { compact: false, planDir } : { compact: false }}>
          <MessageList messages={MESSAGES} busy={false} tts={tts} onRetry={() => {}} />
        </ChatDisplayContext.Provider>
      </UiProvider>
    )

  it('no chat de planejamento, cada arquivo criado ganha "Abrir", que abre no VS Code', async () => {
    const openInEditor = vi.fn(async () => ({ ok: true, message: 'Abrindo no VS Code…' }))
    ;(window as unknown as { api: unknown }).api = { openInEditor }
    renderList(PLAN)
    const links = screen.getAllByRole('link', { name: /Abrir/ })
    expect(links.map((l) => l.textContent)).toEqual(['📄medir.tsAbrir', '📄2026-09-23-01.mdAbrir'])
    fireEvent.click(links[0])
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith(SANDBOX_FILE))
  })

  it('fora do planejamento (sem planDir), nada muda no chat', () => {
    renderList()
    expect(screen.queryByRole('link', { name: /Abrir/ })).toBeNull()
  })
})
