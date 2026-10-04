import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoiceInstallItem } from './VoiceInstallItem'

function stubApi(api: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = api
}

afterEach(cleanup)

describe('VoiceInstallItem (menu do microfone)', () => {
  it('clicar dispara a instalação; cliques repetidos enquanto instala não duplicam; termina como instalado', async () => {
    let finish!: (r: { ok: boolean }) => void
    const voiceInstall = vi.fn(() => new Promise<{ ok: boolean }>((res) => (finish = res)))
    stubApi({ voiceInstall, voiceInstallStatus: vi.fn(async () => ({ installed: false, installing: false })) })
    render(<VoiceInstallItem />)
    const btn = await screen.findByRole('button', { name: /Instalar voz e transcrição/ })
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(voiceInstall).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button').textContent).toContain('Instalando')
    finish({ ok: true })
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('Voz e transcrição instaladas'))
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(voiceInstall).toHaveBeenCalledTimes(1)
  })

  it('já instalado: mostra o estado e desabilita', async () => {
    const voiceInstall = vi.fn()
    stubApi({ voiceInstall, voiceInstallStatus: vi.fn(async () => ({ installed: true, installing: false })) })
    render(<VoiceInstallItem />)
    const btn = (await screen.findByRole('button')) as HTMLButtonElement
    await waitFor(() => expect(btn.textContent).toContain('instaladas'))
    expect(btn.disabled).toBe(true)
    expect(voiceInstall).not.toHaveBeenCalled()
  })

  it('instalação já em andamento no main: abre desabilitado', async () => {
    stubApi({ voiceInstall: vi.fn(), voiceInstallStatus: vi.fn(async () => ({ installed: false, installing: true })) })
    render(<VoiceInstallItem />)
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true))
  })

  it('erro: mostra a mensagem e permite tentar de novo', async () => {
    const voiceInstall = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'sem rede' })
      .mockResolvedValueOnce({ ok: true })
    stubApi({ voiceInstall, voiceInstallStatus: vi.fn(async () => ({ installed: false, installing: false })) })
    render(<VoiceInstallItem />)
    fireEvent.click(await screen.findByRole('button'))
    expect((await screen.findByRole('alert')).textContent).toBe('sem rede')
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('instaladas'))
    expect(voiceInstall).toHaveBeenCalledTimes(2)
  })
})
