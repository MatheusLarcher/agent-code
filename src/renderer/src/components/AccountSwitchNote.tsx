import type { ChatEvent } from '@shared/ipc'

type AccountSwitch = Extract<ChatEvent, { kind: 'account-switch' }>

/**
 * A linha discreta da troca de conta no chat (fica no histórico). A sugestão
 * (interruptor desligado, conta estourada) traz o botão "Continuar na conta X",
 * que é a troca manual retomando a tarefa preservada.
 */
export function AccountSwitchNote({
  event,
  onUseAccount
}: {
  event: AccountSwitch
  onUseAccount?: (accountId: string, continueTask: boolean) => void
}): JSX.Element {
  return (
    <div className="msg system-note account-switch-note" role="status">
      <span>{event.text}</span>
      {event.reason === 'suggest' && onUseAccount && (
        <button type="button" className="btn ghost" onClick={() => onUseAccount(event.toAccountId, true)}>
          Continuar nessa conta
        </button>
      )}
    </div>
  )
}
