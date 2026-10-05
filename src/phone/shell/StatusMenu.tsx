/** A pílula online/offline do cabeçalho e o menu da conexão (endereço, Configurações, Sair). */
import { client, nav } from '../app/runtime'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'

export function StatusPill(): JSX.Element {
  const online = useStore(client.store, (s) => s.online)
  return (
    <button type="button" className={`status ${online ? 'on' : 'off'}`} title="Conexão" onClick={() => nav.set((s) => ({ statusMenuOpen: !s.statusMenuOpen }))}>
      <span className="dot" />
      <span>{online ? 'online' : 'offline'}</span>
    </button>
  )
}

export function confirmExit(): void {
  if (window.confirm('Sair desta conexão? Você precisará parear de novo pelo QR para voltar.')) {
    nav.set({ settingsOpen: false, statusMenuOpen: false })
    client.logout()
  }
}

export function StatusMenu(): JSX.Element | null {
  const open = useStore(nav, (s) => s.statusMenuOpen)
  const base = useStore(client.store, (s) => s.base)
  if (!open) return null
  const close = (): void => nav.set({ statusMenuOpen: false })
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="popover">
        <div className="popover-info">{base ? base.replace(/^https?:\/\//, '') : 'conectado'}</div>
        <button type="button" className="popover-item" onClick={() => nav.set({ statusMenuOpen: false, settingsOpen: true })}>
          <Icon name="gear" size={17} /> Configurações
        </button>
        <button
          type="button"
          className="popover-item danger"
          onClick={() => {
            close()
            confirmExit()
          }}
        >
          <Icon name="exit" size={17} /> Sair da conexão
        </button>
      </div>
    </>
  )
}
