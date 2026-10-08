import { readFailureText } from '../deadline'

/**
 * Leitura de banco que falhou ou passou do prazo (shared/readDeadline.ts): o
 * motivo curto e "tentar de novo". A tela continua mostrando o que já tinha.
 */
export function ReadRetry({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }): JSX.Element {
  return (
    <p className="read-retry" role="status">
      Não deu para carregar {what}: {readFailureText(error, 'erro desconhecido')}{' '}
      <button type="button" onClick={onRetry}>
        Tentar de novo
      </button>
    </p>
  )
}
