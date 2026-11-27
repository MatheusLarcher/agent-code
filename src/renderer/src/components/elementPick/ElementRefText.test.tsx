import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { ChatRow } from '../ChatRows'
import { ElementRefText, elementName } from './ElementRefText'
import type { BubbleElement } from './elementToken'

afterEach(cleanup)

const login: BubbleElement = {
  n: 1, tag: 'button', id: 'login', classes: 'btn primary', tab: 'web - X', selector: '#login', text: 'Entrar', html: '<button id="login" class="btn primary">Entrar</button>'
}
const cta: BubbleElement = { n: 2, tag: 'a', id: '', classes: 'cta', tab: 'Preview', selector: 'main > a.cta', text: '', html: '<a class="cta">' }

describe('"[elemento N]" na bolha vira chip com dica rica', () => {
  it('troca cada "[elemento N]" com dados por um chip e deixa o resto do texto', () => {
    const { container } = render(<ElementRefText text="clique em [elemento 1] e depois [elemento 2]." elements={[login, cta]} />)
    const chips = container.querySelectorAll('.el-ref-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('aria-label')).toBe('Elemento 1: botão “Entrar”')
    expect(chips[1].querySelector('.el-ref-name')?.textContent).toBe('link')
    expect(container.textContent).toBe('clique em 1botão “Entrar” e depois 2link.')
    expect(chips[0].hasAttribute('title')).toBe(false)
  })

  it('"[elemento 9]" sem dados fica como está', () => {
    const { container } = render(<ElementRefText text="veja [elemento 9] e [elemento 1]" elements={[login]} />)
    expect(container.querySelectorAll('.el-ref-chip')).toHaveLength(1)
    expect(container.textContent).toContain('veja [elemento 9] e ')
  })

  it('no hover abre a dica no body com tag, id, classes, texto, seletor e aba; ao sair, some', () => {
    const { container } = render(<ElementRefText text="[elemento 1]" elements={[login]} />)
    const chip = container.querySelector('.el-ref-chip')!
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(chip)
    const tip = screen.getByRole('tooltip')
    expect(tip.parentElement).toBe(document.body)
    expect(chip.getAttribute('aria-describedby')).toBe(tip.id)
    expect(tip.querySelector('.el-ref-tip-tag')?.textContent).toBe('<button>#login.btn.primary')
    expect(tip.querySelector('.el-ref-tip-text')?.textContent).toBe('Entrar')
    expect(tip.textContent).toContain('Seletor#login')
    expect(tip.textContent).toContain('Abaweb - X')
    fireEvent.mouseLeave(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('pelo teclado: o foco abre a dica, Esc e o blur fecham', () => {
    const { container } = render(<ElementRefText text="[elemento 2]" elements={[cta]} />)
    const chip = container.querySelector<HTMLElement>('.el-ref-chip')!
    expect(chip.tabIndex).toBe(0)
    fireEvent.focus(chip)
    const tip = screen.getByRole('tooltip')
    expect(tip.querySelector('.el-ref-tip-text')).toBeNull()
    expect(tip.textContent).toContain('Seletormain > a.cta')
    fireEvent.keyDown(chip, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(chip)
    fireEvent.blur(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('rolar qualquer coisa (a conversa ou a janela) fecha a dica, e o listener sai junto', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { container } = render(
      <div className="rolagem">
        <ElementRefText text="[elemento 1]" elements={[login]} />
      </div>
    )
    const chip = container.querySelector('.el-ref-chip')!
    fireEvent.mouseEnter(chip)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    const onScroll = add.mock.calls.find((c) => c[0] === 'scroll')
    expect(onScroll?.[2]).toMatchObject({ capture: true })
    // Rolagem num ancestral (não borbulha): só um listener em captura no window pega.
    fireEvent.scroll(container.querySelector('.rolagem')!)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(remove.mock.calls.some((c) => c[0] === 'scroll' && c[1] === onScroll?.[1])).toBe(true)
    // Aberta de novo, a rolagem da janela também fecha.
    fireEvent.mouseEnter(chip)
    fireEvent.scroll(window)
    expect(screen.queryByRole('tooltip')).toBeNull()
    add.mockRestore()
    remove.mockRestore()
  })

  it('nome do chip: o que é, em português, e o texto ou o id; nunca classe interna', () => {
    expect(elementName(login)).toBe('botão “Entrar”')
    expect(elementName({ ...login, text: '' })).toBe('botão #login')
    expect(elementName(cta)).toBe('link')
    expect(elementName({ ...cta, tag: 'div', classes: 'pv-sl-shape' })).toBe('forma do slide')
    expect(elementName({ ...cta, tag: 'h2', text: 'Layout' })).toBe('título “Layout”')
    expect(elementName({ ...cta, tag: 'p', text: 'Um texto bem comprido que não cabe inteiro na etiqueta' })).toMatch(/^parágrafo “.+…”$/)
  })
})

describe('UserRow com elementos', () => {
  const ctx = { resolveRef: null, lastTsId: null }
  const row = (m: UIMessage): HTMLElement =>
    render(
      <UiProvider>
        <ChatRow m={m} ctx={ctx} />
      </UiProvider>
    ).container

  it('a bolha enviada mostra o chip e a dica no hover', () => {
    const el = row({ kind: 'user', id: 'u1', text: 'muda a cor de [elemento 1]', elements: [login] })
    const chip = el.querySelector('.msg.user .bubble .el-ref-chip')!
    expect(chip).toBeTruthy()
    expect(el.querySelector('.msg.user .bubble')?.textContent).toBe('muda a cor de 1botão “Entrar”')
    fireEvent.mouseEnter(chip)
    expect(screen.getByRole('tooltip').textContent).toContain('Elemento 1')
  })

  it('bolha antiga, sem dados dos elementos, fica com o texto cru', () => {
    const el = row({ kind: 'user', id: 'u2', text: 'muda [elemento 1]' })
    expect(el.querySelector('.el-ref-chip')).toBeNull()
    expect(el.querySelector('.msg.user .bubble')?.textContent).toBe('muda [elemento 1]')
  })
})
