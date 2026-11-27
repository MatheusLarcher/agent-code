/** Ajudas de teste para o ModelSelect (o seletor de modelo personalizado). */
import { fireEvent } from '@testing-library/react'

/** O id do modelo mostrado no botão. */
export function modelValue(trigger: Element): string {
  return trigger.getAttribute('data-value') ?? ''
}

/** As opções da lista (que fica no DOM mesmo fechada). */
export function modelOptions(trigger: Element): { value: string; textContent: string }[] {
  const list = trigger.parentElement?.querySelector('[role="listbox"]')
  return [...(list?.querySelectorAll('[role="option"]') ?? [])].map((o) => ({
    value: o.getAttribute('data-value') ?? '',
    textContent: o.textContent ?? '',
  }))
}

/** Escolhe um modelo como o usuário: abre a lista e clica na opção. */
export function pickModel(trigger: Element, id: string): void {
  fireEvent.click(trigger)
  const options = trigger.parentElement?.querySelectorAll('[role="option"]') ?? []
  const option = [...options].find((o) => o.getAttribute('data-value') === id)
  if (!option) throw new Error(`modelo fora da lista: ${id}`)
  fireEvent.click(option)
}
