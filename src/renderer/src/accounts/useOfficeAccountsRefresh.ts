import { useEffect } from 'react'

/** De quanto em quanto tempo as contas paradas são relidas com o escritório à vista. */
export const OFFICE_ACCOUNTS_REFRESH_MS = 5 * 60_000

/**
 * Releitura do consumo das contas com o Escritório à vista: ao entrar na aba (e
 * ao a janela voltar a ficar visível) e a cada 5 min, lê todas as contas
 * (`claudeAccountsUsage(false)`: HTTP do /usage, sem mandar mensagem; o main
 * guarda 60 s de cache e grava a leitura na conta) e relê a lista. Fora do
 * escritório ou com a janela escondida, não faz nada.
 */
export function useOfficeAccountsRefresh(active: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false
    const read = (): void => {
      if (document.visibilityState !== 'visible') return
      void window.api
        .claudeAccountsUsage?.(false)
        .then(() => {
          if (!disposed) refresh()
        })
        .catch(() => undefined)
    }
    const start = (): void => {
      if (timer || document.visibilityState !== 'visible') return
      read()
      timer = setInterval(read, OFFICE_ACCOUNTS_REFRESH_MS)
    }
    const stop = (): void => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const onVisibility = (): void => (document.visibilityState === 'visible' ? start() : stop())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, refresh])
}
