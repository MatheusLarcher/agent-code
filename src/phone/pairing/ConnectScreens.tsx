/** As telas antes do app: parear por QR, reconectando à filial salva (com troca de filial) e "outro celular pareado". */
import { confirmForget, forgetLabel } from '../app/filiais'
import { client, openScanner } from '../app/runtime'
import { isApk } from '../app/platform'
import { usePcs } from '../app/usePcs'
import { activePc, otherPcs, pcLabel } from '../core/pcs'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'

/** A tela do QR: o leitor é o único do app (FilialScanner, montado na raiz); a falha da câmera vira toast de erro. */
export function PairScreen(): JSX.Element {
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
        <button type="button" className="btn primary big" onClick={() => openScanner()}>
          <Icon name="camera" size={20} /> Escanear QR
        </button>
      </div>
      <p className="pair-foot">Mantém o app conectado à última sessão automaticamente.</p>
    </section>
  )
}

/**
 * Reconectando: a filial ativa está desligada e o app tenta de novo (espera de até 15 s). No APK dá para trocar
 * para outra filial salva ou abrir uma nova; esquecer a filial é a ação mais discreta e pede confirmação.
 */
export function PairingScreen(): JSX.Element {
  const detail = useStore(client.store, (s) => s.pairingDetail)
  const status = useStore(client.store, (s) => s.pairingStatus)
  const list = usePcs()
  const active = activePc(list)
  const apk = isApk()
  return (
    <section className="pair-screen">
      <div className="pair-card reconnect-card">
        <div className="brand">
          <div className="brand-logo"><span className="spinner" /></div>
          <h1>Reconectando</h1>
        </div>
        {active && <p className="reconnect-filial">{`Filial ${pcLabel(active, list)}`}</p>}
        <p className="sub">{detail || 'Procurando a ponte do seu PC…'}</p>
        <p className="reconnect-status">{status}</p>
        {apk &&
          otherPcs(list).map((pc) => (
            <button key={pc.id} type="button" className="btn primary big" onClick={() => client.switchPc(pc.id)}>
              {`Trocar para a filial ${pcLabel(pc, list)}`}
            </button>
          ))}
        {apk && (
          <button type="button" className="btn big" onClick={() => openScanner()}>
            <Icon name="plus" size={18} /> Abrir filial
          </button>
        )}
        <button type="button" className="reconnect-forget" onClick={() => confirmForget()}>
          {forgetLabel(list)}
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
        <button type="button" className="btn ghost big" onClick={() => client.leaveBlocked()}>
          Cancelar
        </button>
      </div>
      <p className="pair-foot">Tomar o lugar desconecta o outro celular deste PC.</p>
    </section>
  )
}
