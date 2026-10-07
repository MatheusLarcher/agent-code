/**
 * O leitor de QR único do app. "Escanear QR" (tela do QR) e "Abrir filial" (menu e Reconectando)
 * abrem o MESMO leitor, montado na raiz por cima de qualquer tela (`nav.scanOpen`). QR da ponte →
 * `client.addPc` (salva a filial, ativa e recarrega); QR de outra coisa e falha da câmera viram
 * toast de erro, sem deixar a tela por trás saber de nada.
 */
import { client, nav, toast } from '../app/runtime'
import { useStore } from '../core/store'
import { BACK, useBackHandler } from '../shell/backButton'
import { Scanner } from './Scanner'

export function FilialScanner(): JSX.Element | null {
  const open = useStore(nav, (s) => s.scanOpen)
  const close = (): void => nav.set({ scanOpen: false })
  // Voltar fecha o leitor (a câmera para ao desmontar), como o "Cancelar".
  useBackHandler(BACK.modal, close, open)
  if (!open) return null
  return (
    <Scanner
      onResult={(cfg) => {
        close()
        client.addPc(cfg)
      }}
      onCancel={close}
      onFail={(msg) => {
        close()
        toast(msg, 'erro')
      }}
      onForeign={() => toast('QR não é de uma ponte do Agent Code', 'erro')}
    />
  )
}
