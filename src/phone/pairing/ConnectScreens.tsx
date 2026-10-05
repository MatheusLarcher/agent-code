/** As telas antes do app: parear por QR, reconectando ao pareamento salvo e "outro celular pareado". */
import { useState } from 'react'
import { client } from '../app/runtime'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'
import { Scanner } from './Scanner'

export function PairScreen(): JSX.Element {
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  return (
    <section className="pair-screen">
      <div className="pair-card">
        <div className="brand">
          <div className="brand-logo">◆</div>
          <h1>Agent Remote</h1>
        </div>
        <p className="sub">
          No app do PC, abra <b>Controle remoto → Ligar ponte</b> e escaneie o QR.
        </p>
        <button
          type="button"
          className="btn primary big"
          onClick={() => {
            setError('')
            setScanning(true)
          }}
        >
          <Icon name="camera" size={20} /> Escanear QR
        </button>
        {error && <p className="pair-error">{error}</p>}
      </div>
      <p className="pair-foot">Mantém o app conectado à última sessão automaticamente.</p>
      {scanning && (
        <Scanner
          onResult={(cfg) => {
            setScanning(false)
            client.applyConfig(cfg)
          }}
          onCancel={() => setScanning(false)}
          onFail={(msg) => {
            setScanning(false)
            setError(msg)
          }}
        />
      )}
    </section>
  )
}

export function PairingScreen(): JSX.Element {
  const detail = useStore(client.store, (s) => s.pairingDetail)
  const status = useStore(client.store, (s) => s.pairingStatus)
  return (
    <section className="pair-screen">
      <div className="pair-card reconnect-card">
        <div className="brand">
          <div className="brand-logo"><span className="spinner" /></div>
          <h1>Reconectando</h1>
        </div>
        <p className="sub">{detail || 'Procurando a ponte do seu PC…'}</p>
        <p className="reconnect-status">{status}</p>
        <button type="button" className="btn ghost big" onClick={() => client.logout()}>
          Cancelar e escanear QR
        </button>
      </div>
      <p className="pair-foot">Seu pareamento fica salvo neste celular.</p>
    </section>
  )
}

export function BlockedScreen(): JSX.Element {
  const name = useStore(client.store, (s) => s.blockedName)
  return (
    <section className="pair-screen">
      <div className="pair-card reconnect-card">
        <div className="brand">
          <div className="brand-logo">⚠</div>
          <h1>Outro celular pareado</h1>
        </div>
        <p className="sub">
          Este PC já está pareado com <b>{name || 'outro celular'}</b>. Cada PC aceita um celular por vez.
        </p>
        <button type="button" className="btn primary big" onClick={() => client.takeover()}>
          Usar este celular
        </button>
        <button type="button" className="btn ghost big" onClick={() => client.logout()}>
          Cancelar
        </button>
      </div>
      <p className="pair-foot">Tomar o lugar desconecta o outro celular deste PC.</p>
    </section>
  )
}
