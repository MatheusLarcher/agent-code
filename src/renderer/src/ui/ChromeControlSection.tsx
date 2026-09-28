import { useEffect, useState } from 'react'
import type { ChromeBridgeStatus } from '@shared/chromeBridge'
import { useUI } from './UiProvider'
import { IconMonitor } from '../components/Icons'

/** Nome curto do navegador a partir do userAgent enviado pela extensão. */
function browserName(ua: string | null): string {
  if (!ua) return 'navegador'
  if (/Edg\//.test(ua)) return 'Edge'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Brave/.test(ua)) return 'Brave'
  if (/Chrome\//.test(ua)) return 'Chrome'
  return 'navegador'
}

/**
 * Seção "Permitir controle do Chrome" da aba Geral. Autocontida: lê o estado
 * da config, assina o broadcast do toggle e o status da ponte, para refletir
 * mudanças sem reabrir o modal.
 */
export function ChromeControlSection(): JSX.Element {
  const { notify } = useUI()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<ChromeBridgeStatus | null>(null)
  const [extPath, setExtPath] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api
      .getConfig()
      .then((c) => alive && setEnabled(c.chromeControlEnabled === true))
      .catch(() => undefined)
    void window.api
      .getChromeBridgeStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    const offEnabled = window.api.onChromeControlChanged(setEnabled)
    const offStatus = window.api.onChromeBridgeStatusChanged(setStatus)
    return () => {
      alive = false
      offEnabled()
      offStatus()
    }
  }, [])

  const toggle = async (on: boolean): Promise<void> => {
    try {
      await window.api.setChromeControlEnabled(on)
      setEnabled(on)
      notify(
        on ? 'aviso' : 'sucesso',
        on
          ? 'Controle do Chrome ativado. O agente pode interagir com o seu navegador.'
          : 'Controle do Chrome desativado.'
      )
    } catch (error) {
      notify('erro', `Não foi possível alterar o controle do Chrome: ${String(error)}`)
    }
  }

  const install = async (): Promise<void> => {
    setInstalling(true)
    try {
      setExtPath(await window.api.installChromeExtension())
      notify('sucesso', 'Extensão preparada. Siga os passos para carregá-la no Chrome.')
    } catch (error) {
      notify('erro', `Não foi possível instalar a extensão: ${String(error)}`)
    } finally {
      setInstalling(false)
    }
  }

  const copyPath = async (): Promise<void> => {
    if (!extPath) return
    try {
      await navigator.clipboard.writeText(extPath)
      notify('sucesso', 'Caminho copiado.')
    } catch (error) {
      notify('erro', `Não foi possível copiar: ${String(error)}`)
    }
  }

  const connected = status?.connected === true
  return (
    <section className={`settings-section windows-control-section ${enabled ? 'on' : ''}`}>
      <label className="settings-switch-row">
        <span className="settings-switch-text">
          <strong>
            <IconMonitor size={15} /> Permitir controle do Chrome
          </strong>
          <span className="settings-desc">
            Permite que o agente use o seu Chrome (abas, sessões e logins) por meio de uma extensão local.
          </span>
          <span className="settings-desc">
            {connected ? `Conectado · ${browserName(status?.userAgent ?? null)}` : 'Não conectado'}
          </span>
        </span>
        <input
          className="switch-input"
          type="checkbox"
          checked={enabled}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span className="switch-visual" aria-hidden="true" />
      </label>
      <div className="settings-row">
        <button className="btn" type="button" disabled={installing} onClick={() => void install()}>
          {installing ? 'Instalando…' : 'Instalar extensão'}
        </button>
      </div>
      {extPath && (
        <ol className="settings-desc">
          <li>
            Ligue o <strong>Modo do desenvolvedor</strong> em chrome://extensions.
          </li>
          <li>
            Clique em <strong>Carregar sem compactação</strong>.
          </li>
          <li>
            Escolha a pasta <code>{extPath}</code>{' '}
            <button className="btn ghost" type="button" onClick={() => void copyPath()}>
              Copiar caminho
            </button>
          </li>
        </ol>
      )}
    </section>
  )
}
