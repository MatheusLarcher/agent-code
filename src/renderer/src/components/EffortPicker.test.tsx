import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AUTO_EFFORT, AUTO_MODEL } from '@shared/ipc'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AUTO_EFFORT_HINT, clampedPosition, EffortPicker, effortPositions, effortShortLabel } from './EffortPicker'
import { effortLevelsFor } from '../effortOptions'

afterEach(cleanup)

const LEVELS = effortLevelsFor('claude-sonnet-5')

function renderPicker(over: Partial<ComponentProps<typeof EffortPicker>> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <EffortPicker levels={LEVELS} value="high" autoAvailable locked={false} onChange={onChange} {...over} />
  )
  return { ...utils, onChange }
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: /Esforço/ })
const openPopover = (): HTMLInputElement => {
  fireEvent.click(trigger())
  return screen.getByRole('slider', { name: 'Esforço' }) as HTMLInputElement
}

describe('effortPositions / effortShortLabel', () => {
  it('Automático só na ponta esquerda quando oferecido', () => {
    expect(effortPositions(LEVELS, true).map((p) => p.value)).toEqual([AUTO_EFFORT, ...LEVELS.map((l) => l.value)])
    expect(effortPositions(LEVELS, false).map((p) => p.value)).toEqual(LEVELS.map((l) => l.value))
  })

  it('rótulo curto: nível fixo, "Auto" e "Auto · X" com o esforço em uso', () => {
    expect(effortShortLabel({ value: 'high', label: 'Alto' })).toBe('Alto')
    expect(effortShortLabel({ value: AUTO_EFFORT, label: 'Automático' })).toBe('Auto')
    expect(effortShortLabel({ value: AUTO_EFFORT, label: 'Automático' }, 'high')).toBe('Auto · Alto')
    expect(effortShortLabel({ value: AUTO_EFFORT, label: 'Automático' }, 'xhigh')).toBe('Auto · Extra alto')
  })
})

describe('EffortPicker', () => {
  it('botão compacto mostra "Esforço Alto" e o popover abre e fecha', () => {
    renderPicker()
    expect(trigger().textContent).toBe('Esforço Alto')
    expect(screen.queryByRole('slider')).toBeNull()
    openPopover()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(trigger())
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('input range nativo; com TypeSafe, posição 0 = Automático e as setas percorrem todas as posições', () => {
    const { onChange } = renderPicker()
    const slider = openPopover()
    expect(slider.type).toBe('range')
    expect(slider.min).toBe('0')
    expect(slider.max).toBe(String(LEVELS.length))
    expect(slider.step).toBe('1')
    expect(slider.value).toBe('3') // Automático, Baixo, Médio, Alto
    expect(slider.getAttribute('aria-valuetext')).toBe('Alto')
    // Cada posição que a seta alcança grava o valor dela.
    const expected = [AUTO_EFFORT, 'low', 'medium', 'high', 'xhigh', 'max']
    expected.forEach((value, i) => {
      if (value === 'high') return // é o valor atual: não regrava
      fireEvent.change(slider, { target: { value: String(i) } })
      expect(onChange).toHaveBeenLastCalledWith(value)
    })
    expect(onChange).toHaveBeenCalledTimes(expected.length - 1)
  })

  it('sem TypeSafe, a posição Automático não existe e o slider começa em Baixo', () => {
    renderPicker({ autoAvailable: false, value: 'low' })
    const slider = openPopover()
    expect(slider.max).toBe(String(LEVELS.length - 1))
    expect(slider.value).toBe('0')
    expect(slider.getAttribute('aria-valuetext')).toBe('Baixo')
    expect(screen.queryByText(AUTO_EFFORT_HINT)).toBeNull()
  })

  it('sem TypeSafe mas com `auto` gravado: a posição continua, sem trocar a escolha', () => {
    const { onChange } = renderPicker({ autoAvailable: false, value: AUTO_EFFORT })
    expect(trigger().textContent).toBe('Esforço Auto')
    const slider = openPopover()
    expect(slider.value).toBe('0')
    expect(slider.getAttribute('aria-valuetext')).toBe('Automático')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('na posição Automático aparece exatamente a mensagem; outras posições a escondem', () => {
    const { rerender, onChange } = renderPicker({ value: AUTO_EFFORT })
    openPopover()
    const hint = screen.getByRole('note')
    expect(hint.textContent).toBe(
      'Automático: o decisor escolhe o esforço a cada mensagem, pela dificuldade do pedido. Mais esforço pensa mais, demora mais e custa mais.'
    )
    rerender(<EffortPicker levels={LEVELS} value="medium" autoAvailable locked={false} onChange={onChange} />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Médio')
  })

  it('em Automático com decisão já tomada, o seletor mostra "Auto · Alto"', () => {
    renderPicker({ value: AUTO_EFFORT, running: 'high' })
    expect(trigger().textContent).toBe('Esforço Auto · Alto')
    openPopover()
    expect(screen.getByText(/em uso: Alto/)).toBeTruthy()
  })

  it('o nível decidido não aparece fora do Automático', () => {
    renderPicker({ value: 'medium', running: 'high' })
    expect(trigger().textContent).toBe('Esforço Médio')
  })

  it('com tarefa em andamento avisa que muda a partir da próxima mensagem', () => {
    renderPicker({ busy: true })
    expect(trigger().getAttribute('title')).toMatch(/Muda a partir da próxima mensagem/)
  })

  it('nome acessível do botão sempre completo, com o prefixo "Esforço"', () => {
    renderPicker({ value: AUTO_EFFORT, running: 'high' })
    expect(screen.getByRole('button', { name: 'Esforço: Auto · Alto' })).toBeTruthy()
    cleanup()
    renderPicker({ value: 'high' })
    expect(screen.getByRole('button', { name: 'Esforço: Alto' })).toBeTruthy()
  })

  it('o prefixo "Esforço" não é escondido por CSS em nenhuma largura', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    // Nenhuma regra que cite o prefixo (ou o rótulo do botão) pode escondê-lo.
    const rules = css.match(/[^{}]*effort-trigger-(prefix|label)[^{}]*\{[^}]*\}/g) ?? []
    for (const rule of rules) expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden|font-size:\s*0/)
  })

  it('abrir leva o foco ao slider; Escape fecha e devolve o foco ao botão', () => {
    renderPicker()
    const slider = openPopover()
    expect(document.activeElement).toBe(slider)
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('Escape com o foco no botão também fecha', () => {
    renderPicker()
    openPopover()
    trigger().focus()
    fireEvent.keyDown(trigger(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('valor fora da lista cai no nível recortado ao teto do modelo, não em Baixo', () => {
    // Haiku-like: só até Alto. "max" gravado → Alto (como clampEffortToModel).
    const upToHigh = LEVELS.filter((l) => ['low', 'medium', 'high'].includes(l.value))
    renderPicker({ levels: upToHigh, value: 'max', autoAvailable: false })
    expect(trigger().textContent).toBe('Esforço Alto')
    expect(openPopover().getAttribute('aria-valuetext')).toBe('Alto')
    // Com a posição Automático na frente o recorte também ignora o Automático.
    expect(clampedPosition(effortPositions(upToHigh, true), 'xhigh')).toBe(3)
    // Texto que não é nível conta como o padrão (Alto), recortado.
    expect(clampedPosition(effortPositions(upToHigh, false), 'lixo')).toBe(2)
    // Abaixo do menor nível do modelo: o menor.
    expect(clampedPosition(effortPositions(LEVELS.slice(2), false), 'low')).toBe(0)
  })

  it('travado: não abre e chama onLockedClick', () => {
    const onLockedClick = vi.fn()
    renderPicker({ locked: true, onLockedClick })
    fireEvent.click(trigger())
    expect(onLockedClick).toHaveBeenCalled()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('modelo Automático: escada inteira depois da posição Automático', () => {
    renderPicker({ levels: effortLevelsFor(AUTO_MODEL), value: 'max' })
    const slider = openPopover()
    expect(slider.max).toBe('5')
    expect(slider.getAttribute('aria-valuetext')).toBe('Máximo')
  })
})
