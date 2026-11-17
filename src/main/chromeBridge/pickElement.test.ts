// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PICK_NAVIGATED_MESSAGE, PICK_NOT_CONNECTED_MESSAGE, PICK_OUTDATED_MESSAGE, pickElementInChrome, toPickedElement } from './pickElement'
import { ERR_NOT_CONNECTED, ERR_TIMEOUT, PICK_ELEMENT_TIMEOUT_MS } from './protocol'

const REPLY = {
  element: { selector: 'main > button.primary', tagName: 'button', id: '', classes: 'primary', text: 'Comprar', html: '<button class="primary">Comprar</button>', url: 'https://loja.test/p/1' },
  canceled: null,
  tabId: 42,
  url: 'https://loja.test/p/1',
  title: 'Loja — Produto'
}
const bridge = (impl: () => Promise<unknown>) => ({ call: vi.fn(impl) })

describe('Selecionar — pedido à extensão do Chrome', () => {
  it('clique: devolve o elemento com a aba "chrome - <título>" e espera até 120 s', async () => {
    const b = bridge(async () => REPLY)
    const { result, element } = await pickElementInChrome(b)
    expect(b.call).toHaveBeenCalledWith('pickElement', {}, PICK_ELEMENT_TIMEOUT_MS)
    expect(PICK_ELEMENT_TIMEOUT_MS).toBe(120000)
    expect(result).toEqual({ status: 'picked' })
    expect(element).toEqual({
      selector: 'main > button.primary',
      tagName: 'button',
      id: '',
      classes: 'primary',
      text: 'Comprar',
      html: '<button class="primary">Comprar</button>',
      url: 'https://loja.test/p/1',
      tabId: 'chrome:42',
      tabName: 'chrome - Loja — Produto'
    })
  })

  it('Esc (ou 2 min sem clicar): cancelado, sem erro', async () => {
    expect(await pickElementInChrome(bridge(async () => ({ element: null, canceled: 'esc', tabId: 1, url: '', title: '' })))).toEqual({ result: { status: 'canceled' }, element: null })
    expect((await pickElementInChrome(bridge(async () => Promise.reject(new Error(ERR_TIMEOUT))))).result).toEqual({ status: 'canceled' })
  })

  it('extensão desconectada (ou ponte ainda não subiu): pede para instalar/ativar em Configurações', async () => {
    const expected = { status: 'not-connected', message: 'Instale ou ative a extensão do Chrome em Configurações' }
    expect(PICK_NOT_CONNECTED_MESSAGE).toBe(expected.message)
    expect((await pickElementInChrome(null)).result).toEqual(expected)
    expect((await pickElementInChrome(bridge(async () => Promise.reject(new Error(ERR_NOT_CONNECTED))))).result).toEqual(expected)
  })

  it('página navegou no meio, extensão antiga e erro qualquer viram mensagens claras', async () => {
    const fail = async (message: string) => (await pickElementInChrome(bridge(async () => Promise.reject(new Error(message))))).result
    expect(await fail('A página mudou durante a seleção')).toEqual({ status: 'navigated', message: PICK_NAVIGATED_MESSAGE })
    expect(await fail('Método desconhecido: pickElement')).toEqual({ status: 'error', message: PICK_OUTDATED_MESSAGE })
    expect(await fail('Página bloqueada pelo Chrome para extensões')).toEqual({ status: 'error', message: 'Página bloqueada pelo Chrome para extensões' })
  })

  it('resposta malformada não vira elemento; campos são cortados nos limites do chat', () => {
    expect(toPickedElement(null)).toBeNull()
    expect(toPickedElement({ element: { selector: '' } })).toBeNull()
    expect(toPickedElement({ element: 'x' })).toBeNull()
    const big = toPickedElement({ element: { selector: '#a', text: 'x'.repeat(5000), html: 'y'.repeat(9000), tagName: 7 }, url: 'https://a.test/' })
    expect(big).toMatchObject({ selector: '#a', tagName: '', url: 'https://a.test/', tabId: 'chrome', tabName: 'chrome - https://a.test/' })
    expect(big!.text).toHaveLength(2000)
    expect(big!.html).toHaveLength(4000)
  })
})
