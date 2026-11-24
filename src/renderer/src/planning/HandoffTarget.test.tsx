import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { clearHandoffSession } from './handoffFlow'
import { loaded, renderDialog } from './handoffDialogTestUtils'
import { previousConversation, resendableHandoffs, sendOptions } from './HandoffTarget'
import { CWD, SLUG, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(() => {
  cleanup()
  clearHandoffSession(CWD, SLUG)
})

const handoffDialog = (): HTMLElement =>
  screen.getAllByRole('dialog').find((d) => within(d).queryByRole('heading', { name: 'Enviar para implementação' })) as HTMLElement
const targetDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Enviar para qual conversa?' })

/** Um plano com 1 prompt já enviado à conversa `conv-old`. */
function sentOnce(): ReturnType<typeof mockPlanningApi> {
  const m = mockPlanningApi()
  const nome = m.addHandoff('o prompt do plano')
  m.sent.push({ nome, enviadoEm: '2026-09-24T10:00:00.000Z', conversaId: 'conv-old', conversaTitulo: 'Implementação: Antiga' })
  return m
}

async function openResend(exists: (id: string) => boolean) {
  const out = renderDialog(makePlan(), { conversationExists: exists })
  await loaded()
  fireEvent.click(within(handoffDialog()).getByRole('button', { name: 'Enviar de novo' }))
  await screen.findByLabelText('Prompt 1')
  fireEvent.click(within(handoffDialog()).getByRole('button', { name: 'Enviar para implementação' }))
  return out
}

describe('Reenviar um plano já enviado', () => {
  it('pergunta a conversa; "Usar a mesma conversa" manda nela', async () => {
    const m = sentOnce()
    const { onSend } = await openResend(() => true)
    expect(within(targetDialog()).getByText('Implementação: Antiga')).toBeTruthy()
    fireEvent.click(within(targetDialog()).getByRole('button', { name: 'Usar a mesma conversa' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend).toHaveBeenCalledWith(['o prompt do plano'], 'Plano de teste', ['2026-09-22-01.md'], {
      targetConversationId: 'conv-old'
    })
    await waitFor(() => expect(m.sent[0].conversaId).toBe('conv-1'))
  })

  it('"Criar conversa nova" manda sem conversa alvo', async () => {
    sentOnce()
    const { onSend } = await openResend(() => true)
    fireEvent.click(within(targetDialog()).getByRole('button', { name: 'Criar conversa nova' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(['o prompt do plano'], 'Plano de teste', ['2026-09-22-01.md']))
  })

  it('Esc cancela só a pergunta: nada enviado, o diálogo continua aberto', async () => {
    sentOnce()
    const { onSend, onClose } = await openResend(() => true)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Enviar para qual conversa?' })).toBeNull())
    expect(onSend).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(handoffDialog()).toBeTruthy()
  })

  it('conversa anterior apagada: não pergunta, cria outra', async () => {
    sentOnce()
    const { onSend } = await openResend(() => false)
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(['o prompt do plano'], 'Plano de teste', ['2026-09-22-01.md']))
    expect(screen.queryByRole('dialog', { name: 'Enviar para qual conversa?' })).toBeNull()
  })
})

describe('HandoffTarget — regras', () => {
  it('a conversa anterior é a do envio mais recente que ainda existe', () => {
    const sent = [
      { nome: 'a', enviadoEm: '2026-09-24T10:00:00.000Z', conversaId: 'c1', conversaTitulo: 'Um' },
      { nome: 'b', enviadoEm: '2026-09-25T10:00:00.000Z', conversaId: 'c2', conversaTitulo: 'Dois' }
    ]
    expect(previousConversation(sent, () => true)).toEqual({ id: 'c2', title: 'Dois' })
    expect(previousConversation(sent, (id) => id === 'c1')).toEqual({ id: 'c1', title: 'Um' })
    expect(previousConversation(sent, () => false)).toBeNull()
  })

  it('substituído ou sem arquivo não pode ser reenviado', () => {
    const handoffs = [{ name: 'a', content: 'x', createdAt: 0 }, { name: 'b', content: 'y', createdAt: 0 }]
    const sent = [
      { nome: 'a', enviadoEm: '', conversaId: 'c' },
      { nome: 'b', enviadoEm: '', substituidoPor: 'c' },
      { nome: 'z', enviadoEm: '', conversaId: 'c' }
    ]
    expect([...resendableHandoffs(handoffs, sent)]).toEqual(['a'])
  })

  it('sem opções, o onSend continua com 3 argumentos', () => {
    expect(sendOptions(undefined, {})).toBeUndefined()
    expect(sendOptions({ fastMode: true }, { targetId: 'c' })).toEqual({ fastMode: true, targetConversationId: 'c' })
  })
})
