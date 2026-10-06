/** O leitor de QR: avisa UMA vez por abertura quando o QR não é da ponte e continua lendo até achar o certo. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { PairConfig } from '../core/config'
import { decodeFrame } from './decode'
import { Scanner } from './Scanner'

// Cada quadro lido vem do dublê: o teste escolhe o que a "câmera" enxerga.
vi.mock('./decode', () => ({ decodeFrame: vi.fn(), decodePairing: vi.fn() }))
const frames = vi.mocked(decodeFrame)

const CFG: PairConfig = { base: 'https://relay.nova', token: 'tNova', lan: '' }
const track = { stop: vi.fn() }

/** Deixa a promessa do getUserMedia (e o `.then` do leitor) andarem sem disparar timers. */
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function installCamera(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) }
  })
  // O jsdom não toca vídeo nem desenha canvas: o quadro é "pronto" e o contexto devolve pixels vazios.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 8 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 8 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 })
  } as unknown as CanvasRenderingContext2D)
}

describe('Scanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    track.stop.mockClear()
    frames.mockReset()
    installCamera()
  })
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'mediaDevices')
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'readyState')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoWidth')
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoHeight')
  })

  it('QR que não é da ponte: onForeign UMA vez por abertura, sem fechar; depois o QR certo entrega o pareamento', async () => {
    frames.mockReturnValueOnce(null).mockReturnValueOnce({ foreign: true }).mockReturnValueOnce({ foreign: true }).mockReturnValue({ cfg: CFG })
    const cb = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn(), onForeign: vi.fn() }
    render(<Scanner {...cb} />)
    await flush()
    tick(300) // 1º quadro: sem QR
    expect(cb.onForeign).not.toHaveBeenCalled()
    tick(120) // 2º quadro: QR de outra coisa
    expect(cb.onForeign).toHaveBeenCalledTimes(1)
    tick(120) // 3º quadro: o mesmo QR de outra coisa, ainda na frente da câmera
    expect(cb.onForeign).toHaveBeenCalledTimes(1) // não repete
    expect(cb.onResult).not.toHaveBeenCalled() // e o leitor segue lendo
    tick(120) // 4º quadro: o QR da ponte
    expect(cb.onResult).toHaveBeenCalledTimes(1)
    expect(cb.onResult).toHaveBeenCalledWith(CFG)
    expect(cb.onForeign).toHaveBeenCalledTimes(1)
    expect(track.stop).toHaveBeenCalled() // a câmera é liberada ao entregar
    expect(cb.onCancel).not.toHaveBeenCalled()
    expect(cb.onFail).not.toHaveBeenCalled()
  })

  it('uma nova abertura volta a avisar (o "uma vez" é por montagem do leitor)', async () => {
    frames.mockReturnValue({ foreign: true })
    const first = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn(), onForeign: vi.fn() }
    const view = render(<Scanner {...first} />)
    await flush()
    tick(300)
    tick(120)
    expect(first.onForeign).toHaveBeenCalledTimes(1)
    view.unmount()
    const second = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn(), onForeign: vi.fn() }
    render(<Scanner {...second} />)
    await flush()
    tick(300)
    expect(second.onForeign).toHaveBeenCalledTimes(1)
  })

  it('onForeign é opcional: sem ele, o QR de outra coisa é só ignorado', async () => {
    frames.mockReturnValue({ foreign: true })
    const cb = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn() }
    render(<Scanner {...cb} />)
    await flush()
    tick(300)
    tick(120)
    expect(cb.onResult).not.toHaveBeenCalled()
    expect(cb.onFail).not.toHaveBeenCalled()
  })

  it('Cancelar (e o toque no leitor) chama onCancel', async () => {
    const cb = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn() }
    const { getByRole, container } = render(<Scanner {...cb} />)
    await flush()
    fireEvent.click(getByRole('button', { name: 'Cancelar' }))
    expect(cb.onCancel).toHaveBeenCalled()
    cb.onCancel.mockClear()
    fireEvent.click(container.querySelector('.scanner') as HTMLElement)
    expect(cb.onCancel).toHaveBeenCalledTimes(1)
  })

  it('câmera indisponível: onFail com a explicação (o FilialScanner a mostra num toast de erro)', () => {
    Reflect.deleteProperty(navigator, 'mediaDevices')
    const cb = { onResult: vi.fn(), onCancel: vi.fn(), onFail: vi.fn() }
    render(<Scanner {...cb} />)
    expect(cb.onFail).toHaveBeenCalledTimes(1)
    expect(String(cb.onFail.mock.calls[0][0])).toMatch(/câmera/i)
  })
})
