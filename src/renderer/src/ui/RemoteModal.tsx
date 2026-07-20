import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { REMOTE_PUBLIC_HOST, type RemoteInfo } from '@shared/ipc'
import { useUI } from './UiProvider'

interface Props {
  onClose: () => void
}

const EMPTY: RemoteInfo = {
  running: false,
  url: '',
  ip: '',
  port: 0,
  token: '',
  clients: 0,
  relayConnected: false
}

/** Public endpoint (VPS) the QR encodes — defined in shared/ipc.ts (kept in sync
 *  with the broker the PC dials). */
const PUBLIC_HOST = REMOTE_PUBLIC_HOST

/**
 * Build the public connection URL from a host (e.g. the VPS) and the bridge token.
 * Accepts `host:port`, a bare host, or a full `http(s)://…` URL (origin is kept).
 * Returns '' if the host is empty/invalid so callers fall back to the LAN URL. The
 * phone's parseConfig reads the token from the `?token=` query.
 *
 * `lanAddr` (optional, `ip:port`) rides along as `?lan=` so a phone that scans
 * this (public, VPS) URL still learns the PC's LAN address — the phone client
 * probes it and prefers it over the VPS relay whenever it's reachable (same
 * Wi‑Fi), without needing a second QR or re-pairing when switching networks.
 */
export function buildPublicUrl(host: string, token: string, lanAddr?: string): string {
  const h = host.trim().replace(/\/+$/, '')
  if (!h || !token) return ''
  const candidate = /^https?:\/\//i.test(h) ? h : `http://${h.replace(/^\/+/, '')}`
  try {
    const origin = new URL(candidate).origin
    const lanPart = lanAddr ? `&lan=${encodeURIComponent(lanAddr)}` : ''
    return `${origin}/?token=${encodeURIComponent(token)}${lanPart}`
  } catch {
    return ''
  }
}

/**
 * Modal that runs the LAN bridge so a phone can drive the sessions. Shows a QR
 * (scan → download/open the remote app), the connection info, how many phones
 * are connected, and a button to build the Android APK.
 */
export function RemoteModal({ onClose }: Props): JSX.Element {
  const { notify } = useUI()
  const [info, setInfo] = useState<RemoteInfo>(EMPTY)
  const [qr, setQr] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [building, setBuilding] = useState(false)
  // Resultado do último build: null = nunca rodou nesta sessão; ok = terminou.
  const [buildResult, setBuildResult] = useState<'ok' | 'fail' | null>(null)
  const [buildLog, setBuildLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  // Sync current status on open, and keep the connected-phone count live.
  useEffect(() => {
    void window.api.remoteStatus().then(setInfo)
    const off = window.api.onRemoteClients(setInfo)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // The QR always encodes the public (VPS) URL so a scan connects remotely; the
  // LAN URL rides along in `?lan=` so the phone can still prefer it when it's
  // reachable (same Wi‑Fi), instead of always going through the VPS relay.
  const lanAddr = info.running && info.ip ? `${info.ip}:${info.port}` : ''
  const publicUrl = info.running ? buildPublicUrl(PUBLIC_HOST, info.token, lanAddr) : ''
  const effectiveUrl = publicUrl || info.url

  // Render the QR whenever the effective URL changes (empty when stopped).
  useEffect(() => {
    if (!effectiveUrl) {
      setQr('')
      return
    }
    void QRCode.toDataURL(effectiveUrl, { width: 240, margin: 1, color: { dark: '#1a1917', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''))
  }, [effectiveUrl])

  // Stream APK build progress.
  useEffect(() => {
    const off = window.api.onRemoteBuildProgress((m) => {
      setBuildLog((l) => [...l.slice(-300), m.line])
      if (m.done) {
        setBuilding(false)
        setBuildResult(m.ok ? 'ok' : 'fail')
        notify(m.ok ? 'sucesso' : 'erro', m.line)
      }
    })
    return off
  }, [notify])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [buildLog])

  const toggle = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = info.running ? await window.api.remoteStop() : await window.api.remoteStart()
      setInfo(next)
      if (!info.running && !next.ip) {
        notify('aviso', 'Nenhuma rede local detectada. Conecte o PC a uma rede Wi‑Fi/Ethernet.')
      } else if (!info.running) {
        notify('sucesso', `Ponte ligada em ${next.ip}:${next.port}.`)
      }
    } catch (e) {
      notify('erro', `Falha: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [info.running, notify])

  const build = useCallback(async (): Promise<void> => {
    setBuilding(true)
    setBuildResult(null)
    setBuildLog(['Iniciando build do APK…'])
    try {
      await window.api.buildRemoteApk()
    } catch (e) {
      notify('erro', `Falha no build: ${String(e)}`)
      setBuilding(false)
    }
  }, [notify])

  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text)
    notify('sucesso', 'Copiado.')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card remote-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">📱 Controle remoto (Android)</h3>
        <p className="modal-message">
          Ligue a ponte e escaneie o QR com o celular para enviar comandos ao Claude Code do seu PC.
          O QR conecta pela <b>VPS</b> (acesso remoto, de qualquer rede) assim que o status abaixo ficar
          <b> pronto</b>. Na mesma Wi‑Fi, dá para usar a <b>URL local</b>.
        </p>

        <div className="remote-body">
          <div className="remote-qr-wrap">
            <div className="remote-qr">
              {info.running && qr ? (
                <img src={qr} alt="QR de conexão" width={220} height={220} />
              ) : (
                <div className="remote-qr-empty">{info.running ? 'Gerando QR…' : 'Ponte desligada'}</div>
              )}
            </div>
            {info.running && qr && (
              <span className="remote-qr-caption">🌐 aponta para a VPS (acesso remoto)</span>
            )}
            {building && (
              <span className="remote-build-badge building">⏳ Gerando APK…</span>
            )}
            {!building && buildResult === 'ok' && (
              <span className="remote-build-badge ok">✅ APK gerado — pode escanear o QR</span>
            )}
            {!building && buildResult === 'fail' && (
              <span className="remote-build-badge fail">❌ Falha ao gerar o APK</span>
            )}
          </div>

          <div className="remote-info">
            <div className={`remote-status ${info.running ? 'on' : 'off'}`}>
              ● {info.running ? 'Ligada' : 'Desligada'}
              {info.running && <span className="remote-clients">{info.clients} conectado(s)</span>}
            </div>
            {info.running && (
              <>
                <div className={`relay-status ${info.relayConnected ? 'on' : 'off'}`}>
                  {info.relayConnected
                    ? '🌐 Acesso remoto pronto (conectado ao servidor)'
                    : '⏳ Conectando ao servidor remoto…'}
                </div>
                <label className="remote-field">
                  <span>Endereço</span>
                  <code onClick={() => copy(`${info.ip}:${info.port}`)}>{info.ip}:{info.port}</code>
                </label>
                <label className="remote-field">
                  <span>Token (fixo)</span>
                  <code onClick={() => copy(info.token)}>{info.token}</code>
                </label>
                <label className="remote-field">
                  <span>URL local (mesma Wi‑Fi)</span>
                  <code className="remote-url" onClick={() => copy(info.url)}>{info.url}</code>
                </label>
                {publicUrl && (
                  <label className="remote-field">
                    <span>URL pública (no QR)</span>
                    <code className="remote-url" onClick={() => copy(publicUrl)}>{publicUrl}</code>
                  </label>
                )}
                <p className="remote-hint">
                  O QR aponta para a VPS — funciona de qualquer rede assim que o acesso remoto estiver pronto.
                </p>
              </>
            )}
          </div>
        </div>

        {building || buildLog.length > 0 ? (
          <pre className="remote-buildlog" ref={logRef}>
            {buildLog.join('\n')}
          </pre>
        ) : null}

        <div className="modal-actions remote-actions">
          <button className="btn ghost" onClick={onClose}>
            Fechar
          </button>
          <button className="btn" onClick={build} disabled={building}>
            {building ? 'Gerando APK…' : '🔨 Gerar APK'}
          </button>
          <button className={`btn ${info.running ? 'danger-btn' : 'primary'}`} onClick={toggle} disabled={busy}>
            {info.running ? 'Desligar' : 'Ligar ponte'}
          </button>
        </div>
      </div>
    </div>
  )
}
