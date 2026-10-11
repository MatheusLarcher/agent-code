import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlanningMockupDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { MockupButton } from './MockupButton'

const m = (rel: string, mtimeMs: number): PlanningMockupDto => ({
  path: `C:\\p\\docs\\spec\\plano\\_sandbox\\${rel.replace(/\//g, '\\')}`,
  rel,
  origem: 'sandbox',
  mtimeMs
})

function setup(list: PlanningMockupDto[]) {
  const listMockups = vi.fn(async () => list)
  const openMockup = vi.fn(async () => ({ ok: true as const }))
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    planningListMockups: listMockups,
    planningOpenMockup: openMockup
  }
  render(
    <UiProvider>
      <MockupButton projectCwd={'C:\\p'} slug="plano" />
    </UiProvider>
  )
  return { listMockups, openMockup }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MockupButton', () => {
  it('sem mockup, não aparece', async () => {
    const { listMockups } = setup([])
    await waitFor(() => expect(listMockups).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Ver mockup/ })).toBeNull()
  })

  it('com um mockup, o clique já abre no navegador', async () => {
    const tela = m('tela.html', 1)
    const { openMockup } = setup([tela])
    fireEvent.click(await screen.findByRole('button', { name: 'Ver mockup' }))
    await waitFor(() => expect(openMockup).toHaveBeenCalledWith({ projectCwd: 'C:\\p', slug: 'plano', path: tela.path }))
  })

  it('com vários, abre a lista e abre o escolhido', async () => {
    const a = m('novo.html', 2)
    const b = m('telas/velho.html', 1)
    const { openMockup } = setup([a, b])
    fireEvent.click(await screen.findByRole('button', { name: /Ver mockup \(2\)/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /velho\.html/ }))
    await waitFor(() => expect(openMockup).toHaveBeenCalledWith({ projectCwd: 'C:\\p', slug: 'plano', path: b.path }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
