/**
 * Montagem comum dos testes do HandoffDialog. Não é teste (não casa com
 * *.test.*): só o que HandoffDialog.test.tsx e HandoffDialog.send.test.tsx usam.
 */
import { expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import type { OpenedPlanningDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { HandoffDialog } from './HandoffDialog'
import type { HandoffSendOutcome } from './handoffFlow'
import { CWD, SLUG, makeCard, makePlan } from './planningTestUtils'

export function withAmbiguity(): OpenedPlanningDto {
  const plan = makePlan()
  plan.cards.push(makeCard('amb', { tipo: 'ambiguidade', etapa: 'desenho', titulo: 'Pix ou boleto?', status: 'aberta' }))
  return plan
}

export const CONV = { id: 'conv-1', title: 'Implementação: Plano de teste' }
export const SENT: HandoffSendOutcome = { status: 'sent', delivered: 1, total: 1, conversation: CONV }
const LOADING = 'Lendo os prompts de _handoff/…'

export function renderDialog(
  plan: OpenedPlanningDto = makePlan(),
  over: {
    managerBusy?: boolean
    onSend?: () => Promise<HandoffSendOutcome>
    conversationExists?: (id: string) => boolean
  } = {}
) {
  const onAskManager = vi.fn()
  const onSend = vi.fn(over.onSend ?? (async () => SENT))
  const onClose = vi.fn()
  const onOpenConversation = vi.fn()
  const view = render(
    <UiProvider>
      <HandoffDialog
        projectCwd={CWD}
        slug={SLUG}
        plan={plan}
        managerBusy={over.managerBusy ?? false}
        onAskManager={onAskManager}
        onSend={onSend}
        conversationExists={over.conversationExists}
        onOpenConversation={onOpenConversation}
        onClose={onClose}
      />
    </UiProvider>
  )
  return { onAskManager, onSend, onClose, onOpenConversation, view }
}

export const dialog = (): HTMLElement => screen.getByRole('dialog')
export const button = (name: string | RegExp): HTMLButtonElement =>
  within(dialog()).getByRole('button', { name }) as HTMLButtonElement
/** A 1ª listagem decide o passo inicial; até lá o diálogo só diz que está lendo. */
export const loaded = (): Promise<void> => waitFor(() => expect(screen.queryByText(LOADING)).toBeNull())
export const area = (n: number): HTMLTextAreaElement => screen.getByLabelText(`Prompt ${n}`) as HTMLTextAreaElement
