// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_INSPECTOR } from '../../shared/preview'

// Sem sendToHost: o import não instala o inspetor sozinho.
vi.mock('electron', () => ({ ipcRenderer: {} }))

const { installInspector } = await import('./index')

function fakeIpc() {
  const listeners = new Map<string, (e: unknown, ...a: unknown[]) => void>()
  return {
    sent: [] as unknown[][],
    on(ch: string, l: (e: unknown, ...a: unknown[]) => void) {
      listeners.set(ch, l)
    },
    sendToHost(ch: string, ...args: unknown[]) {
      this.sent.push([ch, ...args])
    },
    emit(ch: string, ...args: unknown[]) {
      listeners.get(ch)?.({}, ...args)
    }
  }
}

describe('preload do seletor (webview)', () => {
  it('avisa ready, marca o clique com número e responde a toggle/clear/Esc', () => {
    document.body.innerHTML = '<main id="m"><button class="cta">Comprar</button><a href="#">x</a></main>'
    const ipc = fakeIpc()
    const state = installInspector(ipc, window)
    expect(ipc.sent).toEqual([[PREVIEW_INSPECTOR.ready]])

    const btn = document.querySelector('button')!
    const link = document.querySelector('a')!
    // Desligado: clique segue normal e nada vai ao host.
    btn.click()
    expect(ipc.sent).toHaveLength(1)

    ipc.emit(PREVIEW_INSPECTOR.toggle, true)
    expect(state.isOn()).toBe(true)
    const pageClick = vi.fn()
    btn.addEventListener('click', pageClick)
    btn.click()
    expect(pageClick).not.toHaveBeenCalled()
    expect(ipc.sent[1]).toEqual([
      PREVIEW_INSPECTOR.picked,
      expect.objectContaining({ tagName: 'button', selector: '#m > button.cta', text: 'Comprar', index: 1, url: location.href })
    ])
    // Mesmo elemento de novo: já marcado, não repete.
    btn.click()
    expect(ipc.sent).toHaveLength(2)
    link.click()
    expect(ipc.sent[2][1]).toMatchObject({ tagName: 'a', index: 2 })

    // clear zera a numeração.
    ipc.emit(PREVIEW_INSPECTOR.clear)
    link.click()
    expect(ipc.sent[3][1]).toMatchObject({ index: 1 })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(state.isOn()).toBe(false)
    expect(ipc.sent.at(-1)).toEqual([PREVIEW_INSPECTOR.esc])
    btn.click()
    expect(pageClick).toHaveBeenCalledTimes(1)
  })

  it('arquivo arrastado sobre a página: avisa o host (dragfile) e barra o padrão; outro arraste passa', () => {
    const ipc = fakeIpc()
    installInspector(ipc, window)
    ipc.sent.length = 0
    const drag = (type: string, types: string[]): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'dataTransfer', { value: { types } })
      window.dispatchEvent(e)
      return e
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    try {
      expect(drag('dragenter', ['Files']).defaultPrevented).toBe(true)
      expect(ipc.sent).toEqual([[PREVIEW_INSPECTOR.dragfile]])
      // dragover em seguida: barra o padrão, mas não repete o aviso antes de 250 ms.
      expect(drag('dragover', ['Files']).defaultPrevented).toBe(true)
      expect(ipc.sent).toHaveLength(1)
      now.mockReturnValue(10_400)
      drag('dragover', ['Files'])
      expect(ipc.sent).toHaveLength(2)
      // Soltar arquivo na página não deixa ela abrir o arquivo.
      expect(drag('drop', ['Files']).defaultPrevented).toBe(true)
      // Arraste de texto/link da própria página: nada muda.
      expect(drag('dragenter', ['text/plain']).defaultPrevented).toBe(false)
      expect(drag('dragover', ['text/uri-list']).defaultPrevented).toBe(false)
      expect(drag('drop', ['text/plain']).defaultPrevented).toBe(false)
      expect(ipc.sent).toHaveLength(2)
    } finally {
      now.mockRestore()
    }
  })

  it('a marca dura enquanto o elemento está no campo de mensagem (sync), não some no Esc', () => {
    document.body.innerHTML = '<main id="s"><button id="a">A</button><button id="b">B</button></main>'
    document.querySelectorAll('[data-agent-preview-inspector]').forEach((n) => n.remove())
    const ipc = fakeIpc()
    installInspector(ipc, window)
    const marks = (): string[] =>
      [...document.querySelectorAll('[data-agent-preview-inspector]')]
        .filter((n) => (n as HTMLElement).style.borderColor !== '' && n.firstElementChild?.textContent)
        .map((n) => n.firstElementChild!.textContent!)
    ipc.emit(PREVIEW_INSPECTOR.toggle, true)
    document.getElementById('a')!.click()
    document.getElementById('b')!.click()
    const selA = (ipc.sent[1][1] as { selector: string }).selector
    const selB = (ipc.sent[2][1] as { selector: string }).selector
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // Esc só desliga o modo: as duas marcas continuam.
    expect(marks()).toEqual(['1', '2'])
    // O "A" saiu do campo: a marca dele some e o "B" vira 1.
    ipc.emit(PREVIEW_INSPECTOR.sync, [selB])
    expect(marks()).toEqual(['1'])
    // Com número: vale o "[elemento N]" global do campo (aqui o 3º do texto,
    // os dois primeiros vieram de outra aba), não a posição nesta aba.
    ipc.emit(PREVIEW_INSPECTOR.sync, [{ selector: selB, n: 3 }])
    expect(marks()).toEqual(['3'])
    // Mensagem enviada (campo vazio): nenhuma marca.
    ipc.emit(PREVIEW_INSPECTOR.sync, [])
    expect(marks()).toEqual([])
    expect(selA).not.toBe(selB)
  })
})
