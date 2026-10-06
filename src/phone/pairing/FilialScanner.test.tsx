/** O leitor de QR único (por cima de qualquer tela): abre por openScanner() e entrega o resultado ao client. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { client, nav, openScanner, toasts } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import type { PairConfig } from '../core/config'
import { FilialScanner } from './FilialScanner'

interface ScannerProps {
  onResult: (cfg: PairConfig) => void
  onCancel: () => void
  onFail: (msg: string) => void
  onForeign?: () => void
}

// O leitor de verdade usa a câmera: aqui um dublê guarda as props que a FilialScanner passa.
const seen = vi.hoisted(() => ({ props: null as ScannerProps | null }))
vi.mock('./Scanner', () => ({
  Scanner: (props: ScannerProps) => {
    seen.props = props
    return <div data-testid="scanner" />
  }
}))

const props = (): ScannerProps => seen.props as ScannerProps
const lastToast = (): { text: string; tipo?: string } | undefined => toasts.get().list.at(-1)
const CFG: PairConfig = { base: 'https://relay.nova', token: 'tNova', lan: '' }

describe('FilialScanner', () => {
  beforeEach(() => {
    resetApp()
    seen.props = null
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('fechado não monta o leitor (nem pede a câmera)', () => {
    render(<FilialScanner />)
    expect(screen.queryByTestId('scanner')).toBeNull()
    expect(seen.props).toBeNull()
  })

  it('openScanner() abre o leitor por cima e fecha o menu', () => {
    nav.set({ statusMenuOpen: true })
    render(<FilialScanner />)
    act(() => openScanner())
    expect(screen.getByTestId('scanner')).toBeDefined()
    expect(nav.get().scanOpen).toBe(true)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('QR da ponte: fecha o leitor e entrega ao client.addPc (que salva, ativa e recarrega)', () => {
    const addPc = vi.spyOn(client, 'addPc').mockImplementation(() => {})
    render(<FilialScanner />)
    act(() => openScanner())
    act(() => props().onResult(CFG))
    expect(addPc).toHaveBeenCalledTimes(1)
    expect(addPc).toHaveBeenCalledWith(CFG)
    expect(nav.get().scanOpen).toBe(false)
    expect(screen.queryByTestId('scanner')).toBeNull()
  })

  it('Cancelar só fecha: nada é salvo e nenhum aviso aparece', () => {
    const addPc = vi.spyOn(client, 'addPc').mockImplementation(() => {})
    render(<FilialScanner />)
    act(() => openScanner())
    act(() => props().onCancel())
    expect(nav.get().scanOpen).toBe(false)
    expect(addPc).not.toHaveBeenCalled()
    expect(toasts.get().list).toEqual([])
  })

  it('falha da câmera: fecha o leitor e mostra a mensagem num toast de erro', () => {
    render(<FilialScanner />)
    act(() => openScanner())
    act(() => props().onFail('Permissão de câmera negada.'))
    expect(nav.get().scanOpen).toBe(false)
    expect(lastToast()).toMatchObject({ text: 'Permissão de câmera negada.', tipo: 'erro' })
  })

  it('QR que não é de uma ponte: avisa com toast de erro e o leitor continua aberto', () => {
    const addPc = vi.spyOn(client, 'addPc').mockImplementation(() => {})
    render(<FilialScanner />)
    act(() => openScanner())
    act(() => props().onForeign?.())
    expect(lastToast()).toMatchObject({ text: 'QR não é de uma ponte do Agent Code', tipo: 'erro' })
    expect(nav.get().scanOpen).toBe(true)
    expect(screen.getByTestId('scanner')).toBeDefined()
    expect(addPc).not.toHaveBeenCalled()
  })
})
