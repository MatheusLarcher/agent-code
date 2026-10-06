/** A raiz do app: o leitor de QR único e os avisos ficam por cima de qualquer tela. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from '../App'
import { client, nav, toast } from './runtime'
import { resetApp, setApk, twoPcs } from './testSupport'

describe('App', () => {
  beforeEach(() => {
    resetApp()
    vi.spyOn(client, 'start').mockImplementation(() => {}) // sem rede: só a montagem das telas
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('tela do QR → "Escanear QR" abre o leitor único; sem câmera (jsdom), a falha vira toast de erro e o leitor fecha', async () => {
    client.store.set({ screen: 'pair' })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Escanear QR/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/câmera/i)
    expect(alert.className).toBe('toast erro')
    expect(nav.get().scanOpen).toBe(false)
  })

  it('Reconectando no APK: o leitor aberto por "Abrir filial" também sobe (e a falha da câmera avisa)', async () => {
    setApk(true)
    twoPcs()
    client.store.set({ screen: 'pairing', pairingStatus: 'Conectando…' })
    render(<App />)
    expect(screen.getByRole('button', { name: 'Trocar para a filial Empresa' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Abrir filial/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/câmera/i)
  })

  it('os toasts aparecem em qualquer tela, com a classe do tipo', () => {
    client.store.set({ screen: 'blocked', blockedName: 'Galaxy' })
    const { container } = render(<App />)
    act(() => {
      toast('Filial Casa conectada', 'sucesso')
    })
    expect(container.querySelector('.toast.sucesso')?.textContent).toBe('Filial Casa conectada')
  })
})
