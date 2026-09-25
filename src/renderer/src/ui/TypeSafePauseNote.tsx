import { useEffect, useState } from 'react'
import type { TypeSafePauseStatus } from '@shared/typesafePause'
import { typeSafePauseText } from './typeSafePauseText'

/**
 * A pausa do roteamento TypeSafe na tela de configuração: o mesmo estado do
 * aviso (toast) que saiu quando a pausa começou. Salvar outra key ou religar o
 * modo tira da pausa na hora.
 */
export function TypeSafePauseNote(): JSX.Element | null {
  const [status, setStatus] = useState<TypeSafePauseStatus | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .typeSafePauseStatus?.()
        .then((next) => alive && setStatus(next))
        .catch(() => undefined)
    }
    load()
    const off = window.api.onTypeSafePaused?.((next) => setStatus(next)) ?? (() => undefined)
    // A key salva no blur sai da pausa no main; relê para o aviso sumir.
    const timer = setInterval(load, 5_000)
    return () => {
      alive = false
      off()
      clearInterval(timer)
    }
  }, [])

  const text = typeSafePauseText(status)
  if (!text) return null
  return (
    <span className="settings-warn">
      {text}. Salvar outra key ou religar o modo volta a consultar na hora.
    </span>
  )
}
