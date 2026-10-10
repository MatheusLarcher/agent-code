import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG, modelSupportsFastMode } from '@shared/ipc'

/** A opção de Fast mode do envio para implementação, como o passo 3 a mostra. */
export interface HandoffFastModeOption {
  on: boolean
  /** O modelo do Agent Manager (o da implementação) tem fast mode? */
  available: boolean
  onChange: (on: boolean) => void
}

/**
 * O Fast mode no envio, que só existe com "Leitura guiada" ligada (lida ao abrir
 * o diálogo; config ilegível = o padrão, desligada). Começa com `projectDefault`
 * (a escolha das conversas do projeto, inheritedFastMode) e o usuário troca na
 * hora; modelo sem fast mode deixa a opção travada e desmarcada.
 *
 * `option` null = sem a opção: o envio é o de antes dela (sem o 4º argumento).
 */
export function useHandoffFastMode(projectDefault: boolean): {
  option: HandoffFastModeOption | null
  sendOptions: { fastMode: boolean } | undefined
} {
  const [state, setState] = useState<{ available: boolean; on: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.resolve()
      .then(() => window.api?.getConfig?.())
      .then((config) => {
        const leituraGuiada = config?.handoff?.leituraGuiada ?? DEFAULT_CONFIG.handoff.leituraGuiada
        if (!alive || !leituraGuiada) return
        const available = modelSupportsFastMode(config?.planning?.model ?? DEFAULT_CONFIG.planning.model)
        setState({ available, on: available && projectDefault })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // Lido uma vez por abertura: a escolha do usuário não volta ao padrão sozinha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!state) return { option: null, sendOptions: undefined }
  return {
    option: { ...state, onChange: (on) => setState((s) => (s ? { ...s, on: s.available && on } : s)) },
    sendOptions: { fastMode: state.available && state.on }
  }
}
