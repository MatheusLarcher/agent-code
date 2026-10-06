/** "Suas filiais" no menu da pílula (só no APK): o título e uma linha por filial salva, na ordem salva, e o separador. */
import { client } from '../app/runtime'
import { usePcs } from '../app/usePcs'
import { pcLabel } from '../core/pcs'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'

/** `onDone` fecha o menu: tocar numa filial sempre o fecha; só em outra filial ele também troca. */
export function FilialList({ onDone }: { onDone: () => void }): JSX.Element | null {
  const list = usePcs()
  const online = useStore(client.store, (s) => s.online)
  if (list.pcs.length === 0) return null
  return (
    <>
      <div className="popover-title">Suas filiais</div>
      {list.pcs.map((pc) => {
        const active = pc.id === list.activeId
        // ● cheio: a ativa, verde online / cinza offline. ○ vazado: as outras (o app não sabe se estão ligadas).
        const dot = active ? (online ? ' on' : ' off') : ''
        return (
          <button
            key={pc.id}
            type="button"
            className="popover-item filial-row"
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              onDone()
              if (!active) client.switchPc(pc.id)
            }}
          >
            <span className={`filial-dot${dot}`} />
            <span className="filial-name">{pcLabel(pc, list)}</span>
            {active && <Icon name="check" size={16} className="filial-check" />}
          </button>
        )
      })}
      <div className="popover-sep" />
    </>
  )
}
