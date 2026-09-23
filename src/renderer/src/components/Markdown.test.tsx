import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CardRefText, Markdown } from './Markdown'
import { makeRefResolver, type RefCard } from '../planning/cardRefs'
import { typeColorVar } from '../planning/cardTypes'

afterEach(cleanup)

const CARDS: RefCard[] = [
  { id: 'login', titulo: 'Login com SSO', tipo: 'requisito' },
  { id: 'banco', titulo: 'Usar Postgres', tipo: 'decisao' },
  { id: 'duvida', titulo: 'Quem aprova a ação?', tipo: 'ambiguidade' }
]
const resolve = makeRefResolver(CARDS)

const chips = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.pl-card-ref')]

describe('Markdown — [[Nome]] de card (só com resolveRef: o chat do Agent Manager)', () => {
  it('[[Nome]] que resolve vira a pílula com a cor do tipo do card; o que não resolve fica como texto', () => {
    const { container } = render(
      <Markdown text={'Veja [[usar postgres]] e [[Quem aprova a acao?]]; [[Fantasma]] não existe.'} resolveRef={resolve} />
    )
    const [banco, duvida] = chips(container)
    expect(chips(container)).toHaveLength(2)
    expect(banco.textContent).toBe('usar postgres')
    expect(banco.getAttribute('data-tipo')).toBe('decisao')
    expect(banco.style.getPropertyValue('--pl-ref')).toBe(typeColorVar('decisao'))
    expect(duvida.getAttribute('data-tipo')).toBe('ambiguidade')
    expect(duvida.style.getPropertyValue('--pl-ref')).toBe(typeColorVar('ambiguidade'))
    // Não é link: nada para clicar/navegar.
    expect(banco.closest('a')).toBeNull()
    expect(container.textContent).toContain('[[Fantasma]] não existe.')
  })

  it('código não é tocado e os links comuns continuam abrindo fora (target=_blank)', () => {
    const { container } = render(
      <Markdown text={'`[[Usar Postgres]]` e [site](https://example.com) e [[Login com SSO]]'} resolveRef={resolve} />
    )
    expect(container.querySelector('code')?.textContent).toBe('[[Usar Postgres]]')
    expect(chips(container).map((c) => c.textContent)).toEqual(['Login com SSO'])
    const link = container.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('sem resolveRef (qualquer outra conversa, a prévia de arquivo): o texto sai como sempre', () => {
    const { container } = render(<Markdown text={'Veja [[Usar Postgres]] e [site](https://example.com)'} />)
    expect(chips(container)).toHaveLength(0)
    expect(container.textContent).toBe('Veja [[Usar Postgres]] e site')
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank')
  })
})

describe('CardRefText — a mensagem do usuário (texto puro)', () => {
  it('pinta cada [[Nome]] que resolve e deixa o resto do texto igual', () => {
    const { container } = render(
      <p>
        <CardRefText text={'ver [[Login com SSO]], [[Nada]] e **[[banco]]**'} resolveRef={resolve} />
      </p>
    )
    expect(chips(container).map((c) => [c.textContent, c.getAttribute('data-tipo')])).toEqual([
      ['Login com SSO', 'requisito'],
      ['banco', 'decisao'] // pelo id também resolve, como no canvas
    ])
    // Texto puro: markdown não é interpretado, só a referência muda.
    expect(container.textContent).toBe('ver Login com SSO, [[Nada]] e **banco**')
  })
})
