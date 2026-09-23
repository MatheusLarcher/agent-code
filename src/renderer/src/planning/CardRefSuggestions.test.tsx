import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { CardRefSuggestions, useCardRefAutocomplete } from './CardRefSuggestions'
import { typeColorVar } from './cardTypes'
import type { RefCard } from './cardRefs'

afterEach(cleanup)

const CARDS: RefCard[] = [
  { id: 'login', titulo: 'Login com SSO', tipo: 'requisito' },
  { id: 'banco', titulo: 'Usar Postgres', tipo: 'decisao' },
  { id: 'fonte', titulo: 'Usar OAuth PKCE', tipo: 'sugestao' },
  { id: 'duvida', titulo: 'Quem aprova a ação?', tipo: 'ambiguidade' }
]

describe('CardRefSuggestions — a lista', () => {
  it('cada item tem o ícone, o nome e a COR do tipo (a mesma do canvas)', () => {
    render(<CardRefSuggestions items={CARDS} active={1} onPick={vi.fn()} id="refs" />)
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.getAttribute('data-tipo'))).toEqual(['requisito', 'decisao', 'sugestao', 'ambiguidade'])
    for (const [i, card] of CARDS.entries()) {
      expect(options[i].style.getPropertyValue('--pl-ref-color')).toBe(typeColorVar(card.tipo))
      expect(options[i].querySelector('svg')).toBeTruthy()
      expect(within(options[i]).getByText(card.titulo)).toBeTruthy()
    }
    // A cor é a do .planning, com a global do app de reserva (vale fora da tela de planejamento).
    expect(typeColorVar('decisao')).toBe('var(--pl-decisao, var(--ok))')
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(options[1].id).toBe('refs-1')
  })

  it('clique escolhe; passar o mouse destaca; sem itens mostra o aviso', () => {
    const onPick = vi.fn()
    const onActiveChange = vi.fn()
    render(<CardRefSuggestions items={CARDS} active={0} onPick={onPick} onActiveChange={onActiveChange} />)
    fireEvent.mouseEnter(screen.getByText('Usar Postgres').closest('li')!)
    expect(onActiveChange).toHaveBeenCalledWith(1)
    // mousedown sem default: o campo de texto não perde o foco.
    expect(fireEvent.mouseDown(screen.getByText('Usar Postgres'))).toBe(false)
    fireEvent.click(screen.getByText('Usar Postgres'))
    expect(onPick).toHaveBeenCalledWith(CARDS[1])
    cleanup()
    render(<CardRefSuggestions items={[]} active={0} onPick={onPick} emptyText="Nada aqui" />)
    expect(screen.getByText('Nada aqui')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

/** Um campo qualquer com o autocomplete ligado — como o Composer do chat usaria. */
function Harness({ excludeId, initial = '' }: { excludeId?: string; initial?: string }): JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const ac = useCardRefAutocomplete({ cards: CARDS, excludeId, value, onChange: setValue, inputRef: ref })
  return (
    <div>
      <textarea
        aria-label="texto"
        ref={ref}
        value={value}
        {...ac.inputAria}
        onChange={(e) => {
          setValue(e.target.value)
          ac.sync(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => void ac.handleKeyDown(e)}
      />
      {ac.open && <CardRefSuggestions id={ac.listId} items={ac.items} active={ac.active} onPick={ac.pick} onActiveChange={ac.setActive} />}
    </div>
  )
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('texto') as HTMLTextAreaElement
const selected = (): string | null | undefined => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent

describe('useCardRefAutocomplete', () => {
  it('"[[" abre, filtra ignorando acento/caixa e tira o card excluído', () => {
    render(<Harness excludeId="login" />)
    fireEvent.change(box(), { target: { value: 'ver [[' } })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.change(box(), { target: { value: 'ver [[ACAO' } })
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-tipo'))).toEqual(['ambiguidade'])
    fireEvent.change(box(), { target: { value: 'ver [[login' } })
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.getByText('Nenhum card com esse nome')).toBeTruthy()
  })

  it('setas andam (dando a volta), Tab insere o NOME do card destacado com o cursor depois', () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: 'a [[usar' } })
    expect(selected()).toContain('Usar Postgres')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()).toContain('Usar OAuth PKCE')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()).toContain('Usar Postgres')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().getAttribute('aria-activedescendant')).toMatch(/-1$/)
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(box().value).toBe('a [[Usar OAuth PKCE]]')
    expect(box().selectionStart).toBe('a [[Usar OAuth PKCE]]'.length)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('clique na lista insere; Esc fecha e só um "[[" novo reabre', () => {
    render(<Harness />)
    fireEvent.change(box(), { target: { value: '[[post' } })
    fireEvent.click(screen.getByText('Usar Postgres'))
    expect(box().value).toBe('[[Usar Postgres]]')

    fireEvent.change(box(), { target: { value: 'x [[q' } })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(box(), { target: { value: 'x [[qu' } }) // o mesmo '[['
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(box(), { target: { value: 'x [[qu y [[' } }) // '[[' novo
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('Enter sem lista aberta não é consumido (o campo segue normal)', () => {
    render(<Harness initial="sem gatilho" />)
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true)
  })
})
