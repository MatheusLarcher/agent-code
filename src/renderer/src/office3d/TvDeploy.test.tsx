/**
 * A aba Implantação da TV: os envios DO PLANO (slug + pasta), o resumo da aba
 * (o envio corrente), o motivo sem leitura do banco e os botões — Abrir
 * conversa, Ir até o agente (com o aviso e a conversa quando ele não está no
 * escritório) e Marcar como concluída.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import type { DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { UiProvider } from '../ui/UiProvider'
import { deploySummary, planEnvios, TvDeploy, type DeployPlan } from './TvDeploy'

afterEach(cleanup)

const at = (min: number): string => new Date(Date.UTC(2026, 9, 5, 12, min)).toISOString()
const PLAN: DeployPlan = { slug: 'checkout', cwd: 'C:\\GitHub\\loja', title: 'Checkout com Pix' }

/** O plano com dois prompts (o 1º concluído, o 2º esperando você) e envios de outro plano e de outro projeto. */
function world(): HandoffEnvio[] {
  return [
    envio({ id: 'p1', ordem: 1, status: 'concluida', projectCwd: 'c:/github/LOJA/', enviadoEm: at(1), updatedAt: at(2), conversationId: 'impl', conversationTitle: 'Implementação: checkout', entregas: [entrega({ id: 'p1-a', envioId: 'p1', status: 'concluida' })] }),
    envio({
      id: 'p2', ordem: 2, status: 'aguardando_voce', projectCwd: 'C:\\GitHub\\loja', enviadoEm: at(5), updatedAt: at(6), conversationId: 'impl', conversationTitle: 'Implementação: checkout',
      entregas: [entrega({ id: 'p2-a', envioId: 'p2', etapaTitulo: 'Tela', status: 'concluida' }), entrega({ id: 'p2-b', envioId: 'p2', etapaId: 'aceite', etapaTitulo: 'Aceite', ordem: 2, status: 'em_andamento' })]
    }),
    envio({ id: 'outro-plano', planSlug: 'login', status: 'falhou', projectCwd: 'C:\\GitHub\\loja', conversationId: 'impl-login' }),
    envio({ id: 'outro-projeto', status: 'parada', projectCwd: 'C:\\GitHub\\outra', conversationId: 'impl-outra' })
  ]
}

const center = (over: Partial<DeliveryCenterValue> = {}): DeliveryCenterValue => ({
  envios: world(),
  error: null,
  correct: vi.fn(async () => ({ ok: true as const, envio: world()[1] })),
  openConversation: vi.fn(),
  ...over
})

function setup(c: DeliveryCenterValue, onGoToAgent?: (id: string) => boolean) {
  const open = vi.fn()
  render(
    <UiProvider>
      <TvDeploy plan={PLAN} center={c} onOpenConversation={open} onGoToAgent={onGoToAgent} />
    </UiProvider>
  )
  return { open }
}

describe('aba Implantação da TV', () => {
  it('os envios do plano: o mesmo slug e a mesma pasta (sem diferença de maiúsculas, barras ou barra no fim), o que precisa de você primeiro', () => {
    expect(planEnvios(world(), PLAN).map((e) => e.id)).toEqual(['p2', 'p1'])
    expect(planEnvios(world(), { slug: 'checkout', cwd: 'D:\\outra' })).toEqual([])
  })

  it('o resumo da aba é o do envio corrente (o último que saiu); sem envios do plano, sem aba; lendo pela 1ª vez, sem aba; sem leitura do banco, o motivo', () => {
    expect(deploySummary(center(), PLAN)).toEqual({ label: 'Implantação · 1/2 · aguardando você', status: 'aguardando_voce' })
    expect(deploySummary(center(), { slug: 'outro', cwd: PLAN.cwd })).toBeNull()
    expect(deploySummary(null, PLAN)).toBeNull()
    expect(deploySummary(center({ envios: null }), PLAN)).toBeNull()
    expect(deploySummary(center({ envios: null, error: 'banco fora do ar' }), PLAN)).toEqual({ label: 'Implantação · sem leitura do banco', status: 'erro' })
  })

  it('o resumo da aba é do envio corrente (o último que saiu), não do primeiro da lista: com um prompt anterior incompleto (que a lista põe antes) e o seguinte em execução, a aba diz "em execução"', () => {
    const envios = [
      envio({ id: 'a', ordem: 1, status: 'incompleta', projectCwd: PLAN.cwd, enviadoEm: at(1), updatedAt: at(9), entregas: [entrega({ id: 'a1', envioId: 'a', status: 'incompleta' })] }),
      envio({ id: 'b', ordem: 2, status: 'em_execucao', projectCwd: PLAN.cwd, enviadoEm: at(5), updatedAt: at(2), entregas: [entrega({ id: 'b1', envioId: 'b', status: 'em_andamento' }), entrega({ id: 'b2', envioId: 'b', etapaId: 'x', ordem: 2 })] })
    ]
    // A lista põe o que precisa de você (incompleta) primeiro…
    expect(planEnvios(envios, PLAN).map((e) => e.id)).toEqual(['a', 'b'])
    // …mas o envio corrente é o que saiu por último.
    expect(deploySummary(center({ envios }), PLAN)).toEqual({ label: 'Implantação · 0/2 · em execução', status: 'em_execucao' })
  })

  it('uma linha por envio do plano (a da tela Entregas); Abrir conversa e Ir até o agente com a conversa do envio; expandir e Marcar como concluída corrige a entrega', async () => {
    const c = center()
    const go = vi.fn(() => true)
    const s = setup(c, go)
    const rows = screen.getAllByTestId('dlv-envio')
    expect(rows.map((r) => r.dataset.envioId)).toEqual(['p2', 'p1'])
    expect(within(rows[0]).getByText('aguardando você')).toBeTruthy()
    expect(within(rows[0]).getByText('1/2')).toBeTruthy()
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Abrir conversa' }))
    expect(s.open).toHaveBeenCalledWith('impl')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Ir até o agente' }))
    expect(go).toHaveBeenCalledWith('impl')
    expect(s.open).toHaveBeenCalledTimes(1)
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Ver as entregas/ }))
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Marcar como concluída' }))
    expect(c.correct).toHaveBeenCalledWith('p2-b', 'concluir')
    expect(await screen.findByText('Entrega "Aceite" marcada como concluída.')).toBeTruthy()
  })

  it('Ir até o agente com ele fora do escritório: o aviso e a conversa dele', async () => {
    const go = vi.fn(() => false)
    const s = setup(center(), go)
    fireEvent.click(screen.getAllByRole('button', { name: 'Ir até o agente' })[0])
    expect(go).toHaveBeenCalledWith('impl')
    expect(s.open).toHaveBeenCalledWith('impl')
    expect(await screen.findByText(/não está no escritório agora/)).toBeTruthy()
  })

  it('sem leitura do banco: o motivo, nunca "nenhum envio"; com a última leitura guardada, o motivo em cima da lista', () => {
    setup(center({ envios: null, error: 'banco fora do ar' }))
    expect(screen.getByRole('alert').textContent).toBe('Não consegui ler as entregas do banco: banco fora do ar')
    expect(screen.queryByTestId('dlv-envio')).toBeNull()
    expect(screen.queryByText(/nenhum envio/i)).toBeNull()
    cleanup()
    setup(center({ error: 'releitura falhou' }))
    expect(screen.getByRole('alert').textContent).toContain('releitura falhou')
    expect(screen.getAllByTestId('dlv-envio')).toHaveLength(2)
  })
})
