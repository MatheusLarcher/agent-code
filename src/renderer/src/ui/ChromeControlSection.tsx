import { useEffect, useState } from 'react'
import type { ChromeBridgeStatus } from '@shared/chromeBridge'
import { chromeExtensionSetupTask } from '@shared/setupTasks'
import { useUI } from './UiProvider'
import { IconMonitor } from '../components/Icons'
import { requestSetupTask } from '../setup/setupAssistant'
import './chromeControl.css'

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
 *
 * A extensão tem dois jeitos de entrar no Chrome: "Instalar para mim" pede ao
 * agente, num chat de sandbox, que abra o Chrome e a carregue pela tela (o
 * Chrome oficial não aceita mais instalar por linha de comando); "Instalar
 * manualmente" abre a pasta e a página e mostra os três passos.
 */
export function ChromeControlSection(): JSX.Element {
  const { notify } = useUI()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<ChromeBridgeStatus | null>(null)
  const [extPath, setExtPath] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [asking, setAsking] = useState(false)

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

  /** O agente instala: prepara a pasta, liga os dois controles que ele usa e manda o pedido. */
  const installForMe = async (): Promise<void> => {
    setAsking(true)
    try {
      const dir = await window.api.installChromeExtension(false)
      await window.api.setWindowsControlEnabled(true)
      await window.api.setChromeControlEnabled(true)
      setEnabled(true)
      if (!requestSetupTask(chromeExtensionSetupTask(dir))) throw new Error('o chat não está disponível agora')
      notify('aviso', 'Pedido enviado ao agente num chat novo. O controle do Windows e o do Chrome foram ligados.')
    } catch (error) {
      notify('erro', `Não foi possível pedir a instalação ao agente: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setAsking(false)
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
      <div className="chrome-install-actions">
        <button
          className={`btn ${connected ? '' : 'primary'}`}
          type="button"
          disabled={asking || installing}
          onClick={() => void installForMe()}
        >
          {asking ? 'Enviando ao agente…' : 'Instalar para mim'}
        </button>
        <button className="btn ghost" type="button" disabled={asking || installing} onClick={() => void install()}>
          {installing ? 'Preparando…' : 'Instalar manualmente'}
        </button>
      </div>
      <span className="settings-desc chrome-install-note">
        Em <strong>Instalar para mim</strong>, o agente abre o Chrome e carrega a extensão num chat novo. Isso liga o
        controle do Windows e o do Chrome.
      </span>
      {extPath && (
        <ol className="settings-desc chrome-install-steps">
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
