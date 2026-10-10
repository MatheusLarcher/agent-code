import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HANDOFF_CYCLE_RULE, HANDOFF_FILES_RULE } from '@shared/handoffGuidance'
import { clearHandoffSession, managerHandoffRequest } from './handoffFlow'
import { button, dialog, loaded, renderDialog } from './handoffDialogTestUtils'
import { CWD, SLUG, makePlan, mockPlanningApi } from './planningTestUtils'

/** O diálogo "Enviar para implementação" lê os interruptores do handoff na hora do pedido. */
function withConfig(handoff: unknown): void {
  const m = mockPlanningApi()
  ;(m.api as Record<string, unknown>).getConfig = vi.fn(async () => ({ handoff }))
}

async function askManager(): Promise<string> {
  const { onAskManager } = renderDialog()
  await loaded()
  fireEvent.click(button('Pedir ao Agent Manager'))
  await waitFor(() => expect(onAskManager).toHaveBeenCalled())
  return onAskManager.mock.calls[0][0] as string
}

afterEach(() => {
  cleanup()
  clearHandoffSession(CWD, SLUG)
})

describe('HandoffDialog — interruptores do handoff no pedido ao Agent Manager', () => {
  it('ciclo ligado: o pedido exige o ciclo', async () => {
    withConfig({ ciclo: true, leituraGuiada: false })
    expect(await askManager()).toContain(HANDOFF_CYCLE_RULE)
  })

  it('leitura guiada ligada: o pedido exige a seção Arquivos', async () => {
    withConfig({ ciclo: false, leituraGuiada: true })
    const text = await askManager()
    expect(text).toContain(HANDOFF_FILES_RULE)
    expect(text).not.toContain(HANDOFF_CYCLE_RULE)
  })

  it('tudo desligado: o pedido de hoje, sem acréscimo', async () => {
    withConfig({ ciclo: false, leituraGuiada: false })
    expect(await askManager()).toBe(managerHandoffRequest(makePlan().dir, 0, 0))
  })

  it('config ilegível: vale o padrão (tudo desligado — o replay e o A/B mostraram piora com o ciclo)', async () => {
    const m = mockPlanningApi()
    ;(m.api as Record<string, unknown>).getConfig = vi.fn(async () => {
      throw new Error('canal fechado')
    })
    expect(await askManager()).not.toContain(HANDOFF_CYCLE_RULE)
  })
})

describe('HandoffDialog — Fast mode no envio (só com "Leitura guiada")', () => {
  function withSendConfig(leituraGuiada: boolean, model = 'claude-opus-5-5'): ReturnType<typeof mockPlanningApi> {
    const m = mockPlanningApi()
    m.addHandoff('# pronto')
    ;(m.api as Record<string, unknown>).getConfig = vi.fn(async () => ({
      handoff: { ciclo: true, leituraGuiada },
      planning: { model, effort: 'max' }
    }))
    return m
  }
  const fastToggle = (): HTMLInputElement | null => within(dialog()).queryByRole('checkbox', { name: /Fast mode/ })

  it('ligada: a opção começa com a escolha do projeto e vai para o envio; dá para trocar na hora', async () => {
    withSendConfig(true)
    const { onSend } = renderDialog(makePlan(), { fastModeDefault: true })
    await screen.findByLabelText('Prompt 1')
    await waitFor(() => expect(fastToggle()?.checked).toBe(true))
    fireEvent.click(fastToggle()!)
    expect(fastToggle()!.checked).toBe(false)
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[3]).toEqual({ fastMode: false })
  })

  it('ligada e o projeto sem fast mode: começa desmarcada; marcada, vai true', async () => {
    withSendConfig(true)
    const { onSend } = renderDialog(makePlan(), { fastModeDefault: false })
    await screen.findByLabelText('Prompt 1')
    await waitFor(() => expect(fastToggle()).not.toBeNull())
    expect(fastToggle()!.checked).toBe(false)
    fireEvent.click(fastToggle()!)
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[3]).toEqual({ fastMode: true })
  })

  it('modelo do Manager sem fast mode: a opção aparece travada e desmarcada', async () => {
    withSendConfig(true, 'claude-sonnet-5-5')
    renderDialog(makePlan(), { fastModeDefault: true })
    await screen.findByLabelText('Prompt 1')
    await waitFor(() => expect(fastToggle()).not.toBeNull())
    expect(fastToggle()!.checked).toBe(false)
    expect(fastToggle()!.disabled).toBe(true)
  })

  it('desligada: sem a opção, e o envio é o de hoje (sem o 4º argumento)', async () => {
    withSendConfig(false)
    const { onSend } = renderDialog(makePlan(), { fastModeDefault: true })
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(fastToggle()).toBeNull()
    expect(onSend.mock.calls[0]).toHaveLength(3)
  })
})

describe('HandoffDialog — config ilegível no envio', () => {
  it('sem config: sem a opção de Fast mode (padrão = leitura guiada desligada) e envio de hoje', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# pronto')
    ;(m.api as Record<string, unknown>).getConfig = vi.fn(async () => {
      throw new Error('canal fechado')
    })
    const { onSend } = renderDialog(makePlan(), { fastModeDefault: true })
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(within(dialog()).queryByRole('checkbox', { name: /Fast mode/ })).toBeNull()
    expect(onSend.mock.calls[0]).toHaveLength(3)
  })
})
