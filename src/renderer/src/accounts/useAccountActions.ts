import { useCallback } from 'react'
import type { ChatEvent } from '@shared/ipc'
import type { Conversation } from '../types'
import type { ToastType } from '../ui/UiProvider'

type AccountSwitch = Extract<ChatEvent, { kind: 'account-switch' }>

/**
 * As ações de conta que o App dispara: o aviso de troca (toast amarelo na troca
 * automática), a troca manual e o "entrar de novo". A linha no chat vem do
 * próprio evento, pelo reducer de mensagens.
 */
export function useAccountActions(deps: {
  notify: (tipo: ToastType, msg: string) => void
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
  refresh: () => void
}): {
  announce: (event: AccountSwitch) => void
  chooseAccount: (convId: string, accountId: string, continueTask?: boolean) => Promise<void>
  relogin: (accountId: string) => Promise<void>
} {
  const { notify, patchConv, refresh } = deps

  const announce = useCallback(
    (event: AccountSwitch): void => {
      if (event.reason === 'turn-end' || event.reason === 'exhausted') notify('aviso', event.text)
      else if (event.reason === 'manual') notify('sucesso', event.text)
      refresh()
    },
    [notify, refresh]
  )

  const chooseAccount = useCallback(
    async (convId: string, accountId: string, continueTask = false): Promise<void> => {
      const result = await window.api.claudeAccountsUseForConversation(convId, accountId, continueTask).catch(() => null)
      if (!result?.ok) {
        notify('erro', 'Não foi possível usar essa conta. Confira se o login dela está válido.')
        return
      }
      // Sem sessão aberta: a conversa guarda a conta e o próximo início usa ela.
      if (result.nextStart) {
        patchConv(convId, (c) => ({ ...c, claudeAccountId: accountId }))
        notify('sucesso', 'A conversa vai usar essa conta a partir da próxima mensagem.')
      }
    },
    [notify, patchConv]
  )

  const relogin = useCallback(
    async (accountId: string): Promise<void> => {
      notify('aviso', 'Abrindo o navegador: entre de novo com essa conta Claude.')
      const { ok } = await window.api.claudeAccountsRelogin(accountId).catch(() => ({ ok: false }))
      notify(ok ? 'sucesso' : 'erro', ok ? 'Login renovado.' : 'O login não foi concluído.')
      refresh()
    },
    [notify, refresh]
  )

  return { announce, chooseAccount, relogin }
}
