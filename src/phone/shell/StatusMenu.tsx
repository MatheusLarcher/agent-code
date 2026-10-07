/**
 * A pílula do cabeçalho (nome da filial ativa + online/offline) e o menu que ela abre: no APK a lista
 * "Suas filiais", "Abrir filial", Configurações e Esquecer; no navegador, o endereço em uso, Configurações e a saída.
 */
import { confirmForget, forgetLabel } from '../app/filiais'
import { client, nav, openScanner } from '../app/runtime'
import { isApk } from '../app/platform'
import { usePcs } from '../app/usePcs'
import { activePc, pcLabel } from '../core/pcs'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'
import { BACK, useBackHandler } from './backButton'
import { FilialList } from './FilialList'

export function StatusPill(): JSX.Element {
  const online = useStore(client.store, (s) => s.online)
  const list = usePcs()
  const pc = activePc(list)
  const estado = online ? 'online' : 'offline'
  const nome = pc ? pcLabel(pc, list) : null // sem filial salva (navegador): o texto de sempre
  return (
    <button
      type="button"
      className={`status ${online ? 'on' : 'off'}`}
      title="Conexão"
      aria-label={nome ? `Filial ${nome}, ${estado} — abrir menu` : `Conexão ${estado} — abrir menu`}
      onClick={() => nav.set((s) => ({ statusMenuOpen: !s.statusMenuOpen }))}
    >
      <span className="dot" />
      <span className="status-name">{nome ?? estado}</span>
      <Icon name="chevron" size={12} className="status-caret" />
    </button>
  )
}

export function StatusMenu(): JSX.Element | null {
  const open = useStore(nav, (s) => s.statusMenuOpen)
  const base = useStore(client.store, (s) => s.base)
  const list = usePcs()
  const close = (): void => nav.set({ statusMenuOpen: false })
  useBackHandler(BACK.modal, close, open)
  if (!open) return null
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="popover">
        {isApk() ? (
          <>
            <FilialList onDone={close} />
            <button type="button" className="popover-item" onClick={() => openScanner()}>
              <Icon name="plus" size={17} /> Abrir filial
            </button>
          </>
        ) : (
          <div className="popover-info">{base ? base.replace(/^https?:\/\//, '') : 'conectado'}</div>
        )}
        <button type="button" className="popover-item" onClick={() => nav.set({ statusMenuOpen: false, settingsOpen: true })}>
          <Icon name="gear" size={17} /> Configurações
        </button>
        <button type="button" className="popover-item danger" onClick={() => confirmForget()}>
          <Icon name={activePc(list) ? 'x' : 'exit'} size={17} /> {forgetLabel(list)}
        </button>
      </div>
    </>
  )
}
