/** A lista de filiais salvas, reativa: as telas leem o espelho `pcsStore` e se atualizam quando ele muda. */
import { pcsStore, type PcList } from '../core/pcs'
import { useStore } from '../core/store'

export function usePcs(): PcList {
  return useStore(pcsStore, (s) => s)
}
