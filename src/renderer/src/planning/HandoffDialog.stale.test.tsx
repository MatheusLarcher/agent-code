import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { clearHandoffSession } from './handoffFlow'
import { loaded, renderDialog } from './handoffDialogTestUtils'
import { STALE_LABEL } from './HandoffStale'
import { CWD, SLUG, mockPlanningApi } from './planningTestUtils'

/**
 * Prompts ANTIGOS no "Enviar para implementação": selo "desatualizado", aviso
 * no topo com "Descartar os antigos" (que pergunta antes), e nenhum antigo
 * entra no envio sem o usuário incluí-lo de propósito.
 */

afterEach(() => {
  cleanup()
  clearHandoffSession(CWD, SLUG)
})

const handoffDialog = (): HTMLElement =>
  screen.getAllByRole('dialog').find((d) => within(d).queryByRole('heading', { name: 'Enviar para implementação' })) as HTMLElement
const confirmDialog = (title: string): HTMLElement =>
  screen.getByRole('heading', { name: title }).closest('[role="dialog"]') as HTMLElement
const notice = (): HTMLElement | null => screen.queryByRole('region', { name: 'Prompts antigos' })

function withOldAndNew() {
  const mock = mockPlanningApi()
  const old = mock.addHandoff('# Prompt antigo\nfeito antes da mudança')
  const fresh = mock.addHandoff('# Prompt novo\nfeito depois')
  mock.stale.add(old)
  return { mock, old, fresh }
}

describe('HandoffDialog — prompts antigos', () => {
  it('o antigo fica fora da revisão, com o selo; o aviso conta; "Incluir" o traz de propósito', async () => {
    const { old, fresh } = withOldAndNew()
    renderDialog()
    await loaded()

    // Abertura direta só com o novo.
    expect(screen.getByText('Prompt 1 de 1')).toBeTruthy()
    expect(within(handoffDialog()).getByText(fresh)).toBeTruthy()
    expect(within(notice() as HTMLElement).getByText(/1 prompt antigo, de antes da última mudança do plano/)).toBeTruthy()

    const outside = screen.getByRole('region', { name: 'Fora deste envio' })
    const row = within(outside).getByText(`_handoff/${old}`).closest('li') as HTMLElement
    expect(within(row).getByText(STALE_LABEL)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Incluir' }))

    expect(screen.getByText('Prompt 1 de 2')).toBeTruthy()
    const included = screen.getByText(old).closest('section') as HTMLElement
    expect(within(included).getByText(STALE_LABEL)).toBeTruthy()
  })

  it('"Descartar os antigos" pergunta antes: "Manter" não mexe; confirmado, move e some', async () => {
    const { mock, old } = withOldAndNew()
    renderDialog()
    await loaded()

    fireEvent.click(within(notice() as HTMLElement).getByRole('button', { name: 'Descartar os antigos' }))
    fireEvent.click(within(confirmDialog('Descartar os prompts antigos?')).getByRole('button', { name: 'Manter' }))
    expect(mock.api.planningDiscardHandoffs).not.toHaveBeenCalled()
    expect(notice()).toBeTruthy()

    fireEvent.click(within(notice() as HTMLElement).getByRole('button', { name: 'Descartar os antigos' }))
    fireEvent.click(within(confirmDialog('Descartar os prompts antigos?')).getByRole('button', { name: 'Descartar os antigos' }))
    await waitFor(() => expect(notice()).toBeNull())
    expect(mock.api.planningDiscardHandoffs).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG })
    expect(mock.discarded).toEqual([old])
    expect(screen.queryByText(`_handoff/${old}`)).toBeNull()
    expect(screen.getByText('Prompt 1 de 1')).toBeTruthy()
  })

  it('só antigos: abre no "Conferir" com o selo; "Revisar" leva aos antigos para incluir de propósito', async () => {
    const mock = mockPlanningApi()
    const old = mock.addHandoff('# Prompt antigo\n')
    mock.stale.add(old)
    renderDialog()
    await loaded()

    const pending = screen.getByRole('region', { name: 'Prompts a enviar' })
    expect(within(pending).getByText(STALE_LABEL)).toBeTruthy()
    fireEvent.click(within(handoffDialog()).getByRole('button', { name: 'Revisar prompt' }))
    // Nenhum prompt na revisão: o antigo espera em "fora deste envio".
    expect(screen.queryByText(/Prompt 1 de/)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Fora deste envio' })).getByText(`_handoff/${old}`)).toBeTruthy()
    expect((within(handoffDialog()).getByRole('button', { name: 'Enviar para implementação' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('o rascunho automático passa pela mesma conferência: descartar e gravar, ou manter e gravar', async () => {
    const mock = mockPlanningApi()
    const old = mock.addHandoff('# Prompt antigo\n')
    mock.stale.add(old)
    renderDialog()
    await loaded()

    fireEvent.click(within(handoffDialog()).getByRole('button', { name: 'Usar rascunho automático' }))
    fireEvent.click(within(confirmDialog('Há prompts antigos')).getByRole('button', { name: 'Manter os antigos' }))
    await waitFor(() => expect(mock.api.planningWriteHandoff).toHaveBeenCalledTimes(1))
    expect(mock.api.planningDiscardHandoffs).not.toHaveBeenCalled()
    expect(mock.handoffs.map((h) => h.name)).toContain(old)
  })

  it('confirmado antes do rascunho, os antigos saem primeiro', async () => {
    const mock = mockPlanningApi()
    const old = mock.addHandoff('# Prompt antigo\n')
    mock.stale.add(old)
    renderDialog()
    await loaded()

    fireEvent.click(within(handoffDialog()).getByRole('button', { name: 'Usar rascunho automático' }))
    fireEvent.click(within(confirmDialog('Há prompts antigos')).getByRole('button', { name: 'Descartar e gravar' }))
    await waitFor(() => expect(mock.api.planningWriteHandoff).toHaveBeenCalledTimes(1))
    expect(mock.discarded).toEqual([old])
    expect(mock.api.planningDiscardHandoffs.mock.invocationCallOrder[0]).toBeLessThan(
      mock.api.planningWriteHandoff.mock.invocationCallOrder[0]
    )
  })

  it('prompt antigo já enviado não conta: sem aviso nem selo', async () => {
    const mock = mockPlanningApi()
    const old = mock.addHandoff('# Prompt antigo\n')
    mock.stale.add(old)
    mock.sent.push({ nome: old, enviadoEm: '2026-10-06T20:00:00.000Z', conversaId: 'c', conversaTitulo: 'Implementação' })
    renderDialog()
    await loaded()
    expect(notice()).toBeNull()
    expect(screen.queryByText(STALE_LABEL)).toBeNull()
  })
})
