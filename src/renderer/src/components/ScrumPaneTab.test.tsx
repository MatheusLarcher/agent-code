import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ScrumPanelSnapshot } from '@shared/scrumPanel'
import { envio } from '../office3d/scrum/scrumPanelFixtures'
import { resumeText } from '../office3d/scrum/scrumPanelText'
import { ScrumPaneTab } from './ScrumPaneTab'

const PARADO = envio({ envioId: 'e2', convId: 'c2', conversationTitle: 'Funil de vendas', projectCwd: 'C:\\GitHub\\crm', estado: 'parado', vezes: 3, paradoMotivo: 'o escopo saiu da API' })
const SNAPSHOT: ScrumPanelSnapshot = {
  enabled: true,
  podeParar: true,
  logFile: 'C:\\u\\scrum-decisions.log',
  tiles: { acompanhados: 1, cobrancasHoje: 2, parados: 1 },
  contestados: 0,
  envios: [PARADO]
}

function mount() {
  const api = {
    scrumPanel: vi.fn(async () => ({ ok: true as const, snapshot: SNAPSHOT })),
    scrumHistory: vi.fn(async () => ({ ok: true as const, items: [], total: 0 })),
    scrumChatHistory: vi.fn(async () => ({ ok: true as const, messages: [], hasMore: false })),
    onScrumChanged: vi.fn(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  const cbs = { onCollapse: vi.fn(), onOpenConversation: vi.fn(), onLocate: vi.fn(), onSend: vi.fn() }
  return { api, cbs }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('aba Scrum Master do painel da direita', () => {
  it('os dados só são lidos com a aba aberta, e é o mesmo Diário do Escritório', async () => {
    const { api, cbs } = mount()
    expect(api.scrumPanel).not.toHaveBeenCalled() // aba fechada: nada montado, nada lido
    render(<ScrumPaneTab {...cbs} />)
    expect(await screen.findByTestId('smp-envio')).toBeTruthy()
    expect(api.scrumPanel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Diário do Scrum Master' }).className).toContain('smp-embedded')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('smp-tile-cobrancas').textContent).toBe('2cobranças hoje')
  })

  it('os links do cartão: "Ver a conversa" abre a conversa, o 📍 leva à mesa e "Retomar" manda o aviso', async () => {
    const { cbs } = mount()
    render(<ScrumPaneTab {...cbs} />)
    await screen.findByTestId('smp-envio')
    fireEvent.click(screen.getByRole('button', { name: 'Ver a conversa' }))
    expect(cbs.onOpenConversation).toHaveBeenCalledWith('c2')
    fireEvent.click(screen.getByRole('button', { name: /Funil de vendas/ }))
    expect(cbs.onLocate).toHaveBeenCalledWith('c2')
    fireEvent.click(screen.getByRole('button', { name: 'Retomar com o aviso' }))
    expect(cbs.onSend).toHaveBeenCalledWith('c2', resumeText(PARADO))
  })

  it('o ✕ recolhe o painel; o Esc não (na aba ele não é um diálogo)', async () => {
    const { cbs } = mount()
    render(<ScrumPaneTab {...cbs} />)
    await screen.findByTestId('smp-envio')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cbs.onCollapse).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(cbs.onCollapse).toHaveBeenCalledTimes(1)
  })
})
