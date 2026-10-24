import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppUpdateState } from '@shared/ipc'
import { UpdateBadge, UPDATE_DIALOG_LABEL } from './UpdateBadge'

const base: AppUpdateState = {
  phase: 'ocioso',
  version: null,
  percent: null,
  checkedAt: null,
  error: null,
  canInstallNow: false,
  blockedBy: null
}
const st = (patch: Partial<AppUpdateState>): AppUpdateState => ({ ...base, ...patch })

function view(state: AppUpdateState) {
  const handlers = {
    onInstallNow: vi.fn(),
    onScheduleWhenIdle: vi.fn(),
    onCancelSchedule: vi.fn(),
    onRefresh: vi.fn()
  }
  const r = render(<UpdateBadge state={state} {...handlers} />)
  return { ...handlers, ...r }
}
const openPopover = (): void => {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

afterEach(cleanup)

describe('UpdateBadge', () => {
  it('não aparece em ocioso nem baixando', () => {
    const { container, rerender } = view(base)
    expect(container.innerHTML).toBe('')
    rerender(
      <UpdateBadge state={st({ phase: 'baixando', version: '0.1.150', percent: 43 })} onInstallNow={vi.fn()} onScheduleWhenIdle={vi.fn()} onCancelSchedule={vi.fn()} onRefresh={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('pronta e livre: abre o popover (relendo o estado) e "Atualizar agora" dispara a instalação', () => {
    const h = view(st({ phase: 'pronta', version: '0.1.150', canInstallNow: true }))
    const trigger = screen.getByRole('button', { name: 'Atualização 0.1.150 pronta' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = screen.getByRole('dialog', { name: UPDATE_DIALOG_LABEL })
    expect(dialog.textContent).toContain('Versão 0.1.150 pronta para instalar')
    expect(dialog.textContent).toContain('O app fecha, instala e volta em cerca de meio minuto.')
    // Foco vai para o primeiro botão do popover.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Depois' }))
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar agora' }))
    expect(h.onInstallNow).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Atualizar quando os agentes terminarem' })).toBeNull()
  })

  it('pronta com agente trabalhando: mostra o motivo e oferece agendar', () => {
    const blockedBy = 'A conversa "mapa" está com um turno em andamento.'
    const h = view(st({ phase: 'pronta', version: '0.1.150', canInstallNow: false, blockedBy }))
    openPopover()
    expect(screen.getByText(blockedBy)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Atualizar agora' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar quando os agentes terminarem' }))
    expect(h.onScheduleWhenIdle).toHaveBeenCalledTimes(1)
    expect(h.onInstallNow).not.toHaveBeenCalled()
  })

  it('agendada: tom de espera, motivo atual e "Cancelar agendamento"', () => {
    const h = view(st({ phase: 'agendada', version: '0.1.150', blockedBy: 'Uma tarefa agendada está em execução.' }))
    const trigger = screen.getByRole('button', { name: 'Atualiza quando os agentes terminarem' })
    expect(trigger.className).toContain('scheduled')
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: UPDATE_DIALOG_LABEL })
    expect(dialog.textContent).toContain('Atualização 0.1.150 agendada')
    expect(dialog.textContent).toContain('Esperando: Uma tarefa agendada está em execução.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar agendamento' }))
    expect(h.onCancelSchedule).toHaveBeenCalledTimes(1)
  })

  it('instalando: faixa com a versão, indicador travado e sem popover', () => {
    const { container } = view(st({ phase: 'instalando', version: '0.1.150' }))
    expect(screen.getByText(/Atualizando para 0\.1\.150… o app fecha e volta sozinho/).className).toBe('update-banner')
    expect(container.querySelector('.update-trigger')?.getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc e "Depois" fecham; clique fora fecha', () => {
    view(st({ phase: 'pronta', version: '0.1.150', canInstallNow: true }))
    openPopover()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Depois' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    openPopover()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab circula dentro do popover', () => {
    view(st({ phase: 'pronta', version: '0.1.150', canInstallNow: true }))
    openPopover()
    const dialog = screen.getByRole('dialog')
    const depois = screen.getByRole('button', { name: 'Depois' })
    const agora = screen.getByRole('button', { name: 'Atualizar agora' })
    agora.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(depois)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(agora)
  })

  it('o popover some quando a instalação começa', () => {
    const { rerender } = view(st({ phase: 'pronta', version: '0.1.150', canInstallNow: true }))
    openPopover()
    rerender(
      <UpdateBadge state={st({ phase: 'instalando', version: '0.1.150' })} onInstallNow={vi.fn()} onScheduleWhenIdle={vi.fn()} onCancelSchedule={vi.fn()} onRefresh={vi.fn()} />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
