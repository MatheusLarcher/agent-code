/**
 * O botão "Selecionar" do composer: o usuário escolhe UM elemento numa página do
 * Chrome dele (pela extensão) e ele entra no campo como "[elemento N]". O elemento
 * em si chega pelo `onBrowserPicked` (App → chips → useComposerElements); aqui
 * ficam só o pedido e o que dizer em cada desfecho. Um clique = um elemento.
 */
import { useCallback, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { useUI } from '../../ui/UiProvider'
import { IconPointer } from '../Icons'

export const PICK_HINT = 'Clique no elemento na janela do Chrome. Esc cancela.'
const PICK_UNAVAILABLE = 'Seleção de elemento indisponível nesta versão do app.'

interface Props {
  disabled?: boolean
  /** Testes: a API no lugar de `window.api`. */
  api?: Pick<AgentCodeApi, 'pickElement'>
}

export function PickElementButton({ disabled = false, api }: Props): JSX.Element {
  const { notify } = useUI()
  const [picking, setPicking] = useState(false)

  const pick = useCallback(async (): Promise<void> => {
    const pickElement = (api ?? window.api).pickElement
    if (typeof pickElement !== 'function') return notify('erro', PICK_UNAVAILABLE)
    setPicking(true)
    try {
      const pending = pickElement()
      // O Windows nem sempre deixa o Chrome vir para a frente sozinho: diz onde clicar.
      notify('aviso', PICK_HINT)
      const result = await pending
      if (result.status === 'not-connected' || result.status === 'error') notify('erro', result.message)
      else if (result.status === 'navigated') notify('aviso', result.message)
      // 'picked': o bloco aparece no campo; 'canceled' (Esc): nada a dizer.
    } catch (err) {
      notify('erro', `Não foi possível selecionar: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPicking(false)
    }
  }, [api, notify])

  const tip = picking ? PICK_HINT : 'Selecionar um elemento de uma página do seu Chrome'
  return (
    <button
      type="button"
      className={`ref-btn pick-btn${picking ? ' active' : ''}`}
      onClick={() => void pick()}
      disabled={disabled || picking}
      aria-label="Selecionar"
      aria-busy={picking}
      data-tip={tip}
    >
      <IconPointer />
    </button>
  )
}
