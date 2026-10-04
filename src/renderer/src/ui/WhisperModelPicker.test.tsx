import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_CONFIG, type AppConfig, type WhisperStatus } from '@shared/ipc'
import { WhisperModelPicker } from './WhisperModelPicker'

function stubStatus(status: WhisperStatus): void {
  ;(window as unknown as { api: unknown }).api = {
    voiceStatus: vi.fn(async () => status),
    voiceComponentStatus: vi.fn(async () => ({ installed: false, installing: false }))
  }
}

let latest: AppConfig = DEFAULT_CONFIG
function Harness({ initial }: { initial: AppConfig }): JSX.Element {
  const [cfg, setCfg] = useState(initial)
  latest = cfg
  return <WhisperModelPicker cfg={cfg} setCfg={setCfg} loaded />
}

afterEach(cleanup)

describe('WhisperModelPicker (Configurações › Voz)', () => {
  it('large-v3-turbo é o padrão; mostra onde rodou (GPU) e o tamanho do download', async () => {
    stubStatus({ model: 'turbo-q8', device: 'dml', label: 'GPU (DirectML)' })
    render(<Harness initial={DEFAULT_CONFIG} />)
    const select = screen.getByTestId('whisper-model') as HTMLSelectElement
    expect(select.value).toBe('turbo-q8')
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Whisper large-v3-turbo — padrão, mais preciso',
      'Whisper small — mais leve'
    ])
    await waitFor(() => expect(screen.getByTestId('whisper-device').textContent).toBe('Rodando em: GPU (DirectML).'))
    expect(screen.getByText(/1,6 GB com GPU, ~1,0 GB só na CPU/)).toBeTruthy()
  })

  it('trocar para small grava na config; o dispositivo do turbo não é atribuído ao small', async () => {
    stubStatus({ model: 'turbo-q8', device: 'cpu', label: 'CPU', gpuError: 'DirectML indisponível' })
    render(<Harness initial={DEFAULT_CONFIG} />)
    await waitFor(() => expect(screen.getByTestId('whisper-device').textContent).toMatch(/CPU \(GPU indisponível: DirectML indisponível\)/))
    fireEvent.change(screen.getByTestId('whisper-model'), { target: { value: 'small-fp32' } })
    expect(latest.voice.whisperModel).toBe('small-fp32')
    expect(screen.getByTestId('whisper-device').textContent).toMatch(/tenta a GPU primeiro/)
    expect(screen.getByText(/~925 MB/)).toBeTruthy()
  })
})
