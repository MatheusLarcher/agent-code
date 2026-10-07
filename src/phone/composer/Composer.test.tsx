/**
 * Composer: o Enviar (e os outros botões) não tiram o foco do campo — com o teclado
 * aberto o 1º toque envia e o teclado fica — e a barra de gravação do ditado
 * (cancelar, cronômetro, parar → transcrever, sair da tela solta o microfone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { Composer } from './Composer'
import { fmtClock } from './RecordingBar'

// ---- microfone simulado: getUserMedia + MediaRecorder + AudioContext -------------

const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
let recorders: FakeRecorder[] = []
let audioCtxs: FakeAudio[] = []

class FakeRecorder {
  static isTypeSupported = (): boolean => true
  state = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor() {
    recorders.push(this)
  }
  start(): void {
    this.state = 'recording'
  }
  stop = vi.fn(() => {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
    this.onstop?.()
  })
}

class FakeAudio {
  close = vi.fn(() => Promise.resolve())
  resume = vi.fn(() => Promise.resolve())
  constructor() {
    audioCtxs.push(this)
  }
  createAnalyser(): unknown {
    return { fftSize: 512, getByteTimeDomainData: (a: Uint8Array) => a.fill(128) }
  }
  createMediaStreamSource(): unknown {
    return { connect: () => undefined }
  }
}

const flush = (ms = 0): Promise<void> => act(async () => {
  await new Promise((r) => setTimeout(r, ms))
})

const textarea = (): HTMLTextAreaElement => document.querySelector('.composer textarea') as HTMLTextAreaElement

async function startRecording(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Falar'))
  await flush()
  expect(screen.getByRole('group', { name: 'Gravando áudio' })).toBeTruthy()
}

describe('Composer', () => {
  beforeEach(() => {
    resetApp()
    recorders = []
    audioCtxs = []
    track.stop.mockClear()
    client.store.set({ convId: 'c1', voiceReady: true, conversations: [] })
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioContext', FakeAudio)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => Promise.resolve(stream)) } })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('draft: o texto entra no campo (depois do já digitado), com foco, só quando o nonce muda', async () => {
    const view = render(<Composer />)
    const input = textarea()
    expect(input.value).toBe('') // sem draft: igual a sempre (Central e conversas)
    fireEvent.change(input, { target: { value: 'oi ' } })
    view.rerender(<Composer draft={{ text: '[[Login]] ', nonce: 1 }} />)
    await flush(20)
    expect(input.value).toBe('oi [[Login]] ')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(input.value.length)
    view.rerender(<Composer draft={{ text: '[[Login]] ', nonce: 1 }} />) // mesmo nonce: nada
    view.rerender(<Composer draft={null} />)
    await flush(20)
    expect(input.value).toBe('oi [[Login]] ')
    view.rerender(<Composer draft={{ text: '[[Login]] ', nonce: 2 }} />) // nonce novo: entra de novo
    await flush(20)
    expect(input.value).toBe('oi [[Login]] [[Login]] ')
  })

  it('pointerdown/mousedown no Enviar, no microfone e no anexar não tiram o foco do campo', () => {
    render(<Composer />)
    const input = textarea()
    input.focus()
    for (const label of ['Enviar', 'Falar', 'Anexar']) {
      const btn = screen.getByLabelText(label)
      expect(fireEvent.pointerDown(btn)).toBe(false) // default cancelado = o navegador não move o foco
      expect(fireEvent.mouseDown(btn)).toBe(false)
      expect(document.activeElement).toBe(input)
    }
  })

  it('um toque no Enviar manda a mensagem e o campo continua em foco (teclado aberto)', () => {
    const send = vi.spyOn(client, 'send').mockResolvedValue(undefined as never)
    render(<Composer />)
    const input = textarea()
    input.focus()
    fireEvent.change(input, { target: { value: 'oi pc' } })
    const btn = screen.getByLabelText('Enviar')
    fireEvent.pointerDown(btn)
    fireEvent.mouseDown(btn)
    fireEvent.click(btn)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ text: 'oi pc' })
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  it('gravando, a linha vira a barra com o cronômetro correndo', async () => {
    render(<Composer />)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    fireEvent.click(screen.getByLabelText('Falar'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(textarea()).toBeNull()
    expect(screen.getByRole('timer').textContent).toBe('0:00')
    act(() => {
      vi.advanceTimersByTime(7300)
    })
    expect(screen.getByRole('timer').textContent).toBe('0:07')
  })

  it('cancelar descarta sem transcrever e solta o microfone', async () => {
    const post = vi.spyOn(client, 'post')
    render(<Composer />)
    await startRecording()
    fireEvent.click(screen.getByLabelText('Cancelar gravação'))
    await flush(60) // tempo de sobra para uma transcrição (FileReader → post), se houvesse
    expect(recorders[0].stop).toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
    expect(audioCtxs[0].close).toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(textarea()).toBeTruthy() // a linha do composer voltou
    expect(textarea().value).toBe('')
  })

  it('parar (✓) mostra "Transcrevendo…" e o texto entra no campo', async () => {
    let answer: (v: unknown) => void = () => undefined
    const post = vi.spyOn(client, 'post').mockImplementation(() => new Promise((r) => (answer = r)) as never)
    render(<Composer />)
    await startRecording()
    fireEvent.click(screen.getByLabelText('Parar e transcrever'))
    expect(screen.getByRole('status').textContent).toContain('Transcrevendo')
    expect(track.stop).toHaveBeenCalled() // o microfone já foi solto
    // O FileReader do jsdom (blob → base64) leva alguns ciclos: espera o envio ao PC.
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/api/transcribe', expect.objectContaining({ mimeType: 'audio/webm' }), 120000))
    await act(async () => {
      answer({ ok: true, text: 'olá do ditado' })
    })
    await vi.waitFor(() => expect(textarea()?.value).toBe('olá do ditado'))
  })

  it('sair da tela gravando solta o microfone sem transcrever', async () => {
    const post = vi.spyOn(client, 'post')
    const { unmount } = render(<Composer />)
    await startRecording()
    unmount()
    await flush(60)
    expect(track.stop).toHaveBeenCalled()
    expect(audioCtxs[0].close).toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('cronômetro formata m:ss', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(7300)).toBe('0:07')
    expect(fmtClock(65_000)).toBe('1:05')
  })
})
