/**
 * A linha da tela Entregas pela regra única (shared/stepProgress): o selo é
 * prontas/total das etapas DESTE prompt e "Etapa N de M" é a posição da etapa de
 * agora dele no PLANO — num plano mandado em partes, a 1ª etapa da 2ª parte não
 * é "1/2". O status de cada entrega usa o rótulo compartilhado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { planProgress } from '@shared/stepProgress'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { UiProvider } from '../ui/UiProvider'
import { DeliveryEnvioRow } from './DeliveryEnvioRow'

afterEach(cleanup)

const parte1 = envio({
  id: 'p1', status: 'concluida', enviadoEm: '2026-10-05T11:00:00.000Z',
  entregas: [entrega({ etapaId: 'banco', etapaTitulo: 'Banco', status: 'concluida' }), entrega({ etapaId: 'tela', etapaTitulo: 'Tela', ordem: 2, status: 'concluida' })]
})
const parte2 = envio({
  id: 'p2',
  entregas: [entrega({ etapaId: 'pix', etapaTitulo: 'Pix', status: 'concluida' }), entrega({ etapaId: 'aceite', etapaTitulo: 'Aceite', ordem: 2, status: 'em_andamento' })]
})
const roteiro = ['banco', 'tela', 'pix', 'aceite', 'deploy'].map((id) => ({ id, titulo: id[0].toUpperCase() + id.slice(1) }))

function row(e: HandoffEnvio, roteiroDoPlano?: typeof roteiro): HTMLElement {
  render(
    <UiProvider>
      <ul>
        <DeliveryEnvioRow envio={e} plan={planProgress([parte1, parte2], roteiroDoPlano)} expanded onToggle={() => {}} onOpenConversation={() => {}} correct={vi.fn()} />
      </ul>
    </UiProvider>
  )
  return screen.getByTestId('dlv-envio')
}

describe('DeliveryEnvioRow', () => {
  it('a 2ª parte do plano: "Etapa 4 de 5" com o roteiro (o total é o do plano), o selo é o do prompt', () => {
    const el = row(parte2, roteiro)
    expect(within(el).getByText('Etapa 4 de 5: Aceite')).toBeTruthy()
    expect(within(el).getByText('1/2')).toBeTruthy()
  })

  it('sem roteiro: a posição pela união das entregas do plano', () => {
    expect(within(row(parte2)).getByText('Etapa 4 de 4: Aceite')).toBeTruthy()
  })

  it('prompt com tudo pronto: "Etapas concluídas", mesmo com o plano andando', () => {
    const el = row(parte1, roteiro)
    expect(within(el).getByText('Etapas concluídas')).toBeTruthy()
    expect(within(el).getByText('2/2')).toBeTruthy()
  })

  it('expandida: o status de cada entrega pelo rótulo compartilhado', () => {
    const el = row(parte2, roteiro)
    const entregas = within(el).getAllByTestId('dlv-entrega')
    expect(within(entregas[0]).getByText('concluída')).toBeTruthy()
    expect(within(entregas[1]).getByText('em andamento')).toBeTruthy()
  })
})
