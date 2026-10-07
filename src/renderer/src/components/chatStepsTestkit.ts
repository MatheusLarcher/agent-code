/**
 * Testes: no chat resumido (chatSteps) os cartões ficam atrás da linha-resumo
 * de cada resposta. `openSteps` abre todas as linhas recolhidas dentro de `root`
 * (as já abertas ficam), para o teste chegar aos cartões como o usuário chega.
 */
import { fireEvent } from '@testing-library/react'

export function openSteps(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.chat-step > .central-act[aria-expanded="false"]').forEach((line) => fireEvent.click(line))
}
