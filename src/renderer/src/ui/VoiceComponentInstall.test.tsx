import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SpeechSetupProgress, VoiceComponent } from '@shared/ipc'
import { VoiceComponentInstall } from './VoiceComponentInstall'

function stubApi(api: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = { onSpeechSetupProgress: () => () => {}, ...api }
}

afterEach(cleanup)

describe('VoiceComponentInstall (Configurações › Voz)', () => {
  it('não instalado → Instalar mostra o progresso e termina como instalado', async () => {
    let installed = false
    let push!: (p: SpeechSetupProgress) => void
    let finish!: (r: { ok: boolean }) => void
    const voiceComponentInstall = vi.fn(() => new Promise<{ ok: boolean }>((res) => (finish = res)))
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed, installing: false })),
      voiceComponentInstall,
      onSpeechSetupProgress: (cb: (p: SpeechSetupProgress) => void) => {
        push = cb
        return () => {}
      }
    })
    render(<VoiceComponentInstall component={{ kind: 'stt' }} size="~670 MB" />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Não instalado · ~670 MB'))
    fireEvent.click(screen.getByText('Instalar'))
    fireEvent.click(screen.getByText('Instalando…'))
    expect(voiceComponentInstall).toHaveBeenCalledTimes(1)
    expect(voiceComponentInstall).toHaveBeenCalledWith({ kind: 'stt' })
    act(() => push({ stage: 'downloading', message: 'Baixando o reconhecimento de voz (Parakeet)…', percent: 40, totalMb: 670 }))
    expect(screen.getByRole('status').textContent).toBe('Baixando o reconhecimento de voz (Parakeet)… 40% de ~670 MB')
    installed = true
    await act(async () => finish({ ok: true }))
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Instalado neste computador'))
    expect((screen.getByText('Instalado') as HTMLButtonElement).disabled).toBe(true)
  })

  it('trocar o componente relê o status do componente novo', async () => {
    const voiceComponentStatus = vi.fn(async (c: VoiceComponent) => ({
      installed: c.kind === 'tts',
      installing: false
    }))
    stubApi({ voiceComponentStatus })
    const { rerender } = render(<VoiceComponentInstall component={{ kind: 'tts' }} />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Instalado neste computador'))
    rerender(<VoiceComponentInstall component={{ kind: 'stt' }} />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Não instalado'))
    expect(voiceComponentStatus).toHaveBeenLastCalledWith({ kind: 'stt' })
  })

  it('novo objeto do mesmo componente a cada render não relê o status', async () => {
    const voiceComponentStatus = vi.fn(async () => ({ installed: true, installing: false }))
    stubApi({ voiceComponentStatus })
    const { rerender } = render(<VoiceComponentInstall component={{ kind: 'stt' }} />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Instalado neste computador'))
    rerender(<VoiceComponentInstall component={{ kind: 'stt' }} />)
    await act(async () => {})
    expect(voiceComponentStatus).toHaveBeenCalledTimes(1)
  })

  it('erro na instalação aparece e libera nova tentativa', async () => {
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed: false, installing: false })),
      voiceComponentInstall: vi.fn(async () => ({ ok: false, error: 'sem rede' }))
    })
    render(<VoiceComponentInstall component={{ kind: 'tts' }} />)
    await waitFor(() => expect(screen.getByText('Instalar')).toBeTruthy())
    fireEvent.click(screen.getByText('Instalar'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('sem rede'))
    expect((screen.getByText('Instalar') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Testar transcrição mostra o que foi falado e o que foi ouvido', async () => {
    const voiceTestTranscription = vi.fn(async (_c: VoiceComponent) => ({
      ok: true,
      expected: 'Olá, este é um teste.',
      heard: 'Olá, este é um teste.'
    }))
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed: true, installing: false })),
      voiceTestTranscription
    })
    render(<VoiceComponentInstall component={{ kind: 'stt' }} testable />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Instalado neste computador'))
    fireEvent.click(screen.getByText('Testar transcrição'))
    expect(voiceTestTranscription).toHaveBeenCalledWith({ kind: 'stt' })
    await waitFor(() =>
      expect(screen.getByTestId('voice-test-result').textContent).toBe(
        'Funcionando — falei “Olá, este é um teste.”, ouvi “Olá, este é um teste.”.'
      )
    )
  })

  it('trocar de componente com teste pendente não aplica o resultado antigo ao componente novo', async () => {
    let finish!: (r: { ok: boolean; expected: string; heard: string }) => void
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed: true, installing: false })),
      voiceTestTranscription: vi.fn(() => new Promise((res) => (finish = res)))
    })
    const { rerender } = render(<VoiceComponentInstall component={{ kind: 'stt' }} testable />)
    await waitFor(() => expect(screen.getByTestId('voice-install-status').textContent).toBe('Instalado neste computador'))
    fireEvent.click(screen.getByText('Testar transcrição'))
    expect(screen.getByText('Testando…')).toBeTruthy()
    rerender(<VoiceComponentInstall component={{ kind: 'tts' }} testable />)
    await waitFor(() => expect(screen.getByText('Testar transcrição')).toBeTruthy())
    await act(async () => finish({ ok: true, expected: 'a', heard: 'a' }))
    expect(screen.queryByTestId('voice-test-result')).toBeNull()
  })

  it('trocar de componente com instalação pendente não leva o erro antigo ao componente novo', async () => {
    let finish!: (r: { ok: boolean; error?: string }) => void
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed: false, installing: false })),
      voiceComponentInstall: vi.fn(() => new Promise((res) => (finish = res)))
    })
    const { rerender } = render(<VoiceComponentInstall component={{ kind: 'stt' }} />)
    await waitFor(() => expect(screen.getByText('Instalar')).toBeTruthy())
    fireEvent.click(screen.getByText('Instalar'))
    rerender(<VoiceComponentInstall component={{ kind: 'tts' }} />)
    await waitFor(() => expect(screen.getByText('Instalar')).toBeTruthy())
    await act(async () => finish({ ok: false, error: 'sem rede' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reabrir as Configurações depois de uma instalação que falhou mostra o erro guardado', async () => {
    stubApi({
      voiceComponentStatus: vi.fn(async () => ({ installed: false, installing: false, error: 'sem rede' }))
    })
    render(<VoiceComponentInstall component={{ kind: 'stt' }} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('sem rede'))
  })
})
