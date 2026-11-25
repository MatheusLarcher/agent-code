import { useEffect, useId, useState, type FormEvent } from 'react'
import { SUPORTE_AJUSTES_LIMITES, SUPORTE_LINK_CLIENTE, type SuporteAjustes, type SuporteAjustesPatch } from '@shared/suporteRemoto'
import { useUI } from './UiProvider'
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconHeadset } from '../components/Icons'
import { suporteApi } from '../suporte/useSuporteRemoto'
import '../suporte/suporteRemoto.css'

/**
 * Seção "Suporte Remoto" de Configurações. Autocontida, como a do Chrome: lê e grava pelos
 * canais do suporte, que validam no processo principal. A chave da equipe só sobe: depois
 * de salva a tela sabe apenas que ela existe, e o campo some.
 */
export function SuporteRemotoSection(): JSX.Element | null {
  const { notify, confirm } = useUI()
  const [ajustes, setAjustes] = useState<SuporteAjustes | null>(null)
  const [nome, setNome] = useState('')
  const [chave, setChave] = useState('')
  const [mostrar, setMostrar] = useState(false)
  const [trocando, setTrocando] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const idNome = useId()
  const idChave = useId()
  const idDica = useId()
  const api = suporteApi()

  useEffect(() => {
    const canal = suporteApi()
    if (!canal) return
    let vivo = true
    const receber = (a: SuporteAjustes): void => {
      if (!vivo) return
      setAjustes(a)
      setNome(a.tecnico)
    }
    void canal.getSuporteAjustes().then(receber).catch(() => undefined)
    const sair = canal.onSuporteAjustesMudou(receber)
    return () => {
      vivo = false
      sair()
    }
  }, [])

  if (!api) return null

  /** Manda o patch; o main valida. Devolve se salvou. */
  const salvar = async (patch: SuporteAjustesPatch, feito: string): Promise<boolean> => {
    setSalvando(true)
    try {
      const resultado = await api.salvarSuporteAjustes(patch)
      if (!resultado.ok) {
        notify('erro', resultado.mensagem)
        return false
      }
      setAjustes(resultado.ajustes)
      setNome(resultado.ajustes.tecnico)
      notify('sucesso', feito)
      return true
    } catch {
      notify('erro', 'Não foi possível salvar. Tente de novo.')
      return false
    } finally {
      setSalvando(false)
    }
  }

  const salvarChave = async (evento: FormEvent): Promise<void> => {
    evento.preventDefault()
    if (await salvar({ chave: chave.trim() }, 'Chave da equipe salva.')) {
      // Salva, a chave sai da tela e da memória dela.
      setChave('')
      setMostrar(false)
      setTrocando(false)
    }
  }

  const apagarChave = async (): Promise<void> => {
    const sim = await confirm({
      title: 'Apagar a Chave da Equipe?',
      message: 'O suporte remoto será desativado neste computador.',
      confirmLabel: 'Apagar chave',
      cancelLabel: 'Manter chave',
      danger: true
    })
    if (sim) await salvar({ chave: '' }, 'Chave apagada. O suporte remoto foi desativado.')
  }

  const copiarLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SUPORTE_LINK_CLIENTE)
      notify('sucesso', 'Link copiado.')
    } catch {
      notify('erro', 'Não foi possível copiar o link.')
    }
  }

  const carregado = ajustes !== null
  const ativado = ajustes?.ativado === true
  const temChave = ajustes?.temChave === true
  const editandoChave = carregado && (!temChave || trocando)
  const nomeMudou = carregado && nome.trim() !== ajustes.tecnico

  return (
    <section className={`settings-section suporte-secao ${ativado ? 'on' : ''}`}>
      <label className="settings-switch-row">
        <span className="settings-switch-text">
          <strong>
            <IconHeadset size={15} aria-hidden="true" /> Suporte Remoto
          </strong>
          {carregado && !temChave && (
            <span className="settings-desc" id={idDica}>
              Salve a chave da equipe para ativar.
            </span>
          )}
        </span>
        <input
          className="switch-input"
          type="checkbox"
          checked={ativado}
          disabled={!carregado || salvando || (!temChave && !ativado)}
          aria-describedby={carregado && !temChave ? idDica : undefined}
          onChange={(e) => {
            const ligar = e.target.checked
            // Sem chave não liga, nem que o evento chegue com o campo desabilitado.
            if (ligar && !temChave) return
            void salvar({ ativado: ligar }, ligar ? 'Suporte remoto ativado.' : 'Suporte remoto desativado.')
          }}
        />
        <span className="switch-visual" aria-hidden="true" />
      </label>

      <div className="suporte-secao-campos">
        <div className="settings-field">
          {editandoChave ? (
            <label className="settings-field-label" htmlFor={idChave}>
              Chave da Equipe
            </label>
          ) : (
            <span className="settings-field-label">Chave da Equipe</span>
          )}
          {editandoChave ? (
            <form className="settings-key-row" onSubmit={(e) => void salvarChave(e)}>
              <input
                id={idChave}
                className="settings-input"
                type={mostrar ? 'text' : 'password'}
                name="chave-da-equipe"
                value={chave}
                placeholder="Cole a chave que a equipe passou…"
                autoComplete="off"
                spellCheck={false}
                maxLength={SUPORTE_AJUSTES_LIMITES.chaveMax}
                onChange={(e) => setChave(e.target.value)}
              />
              <button
                className="btn ghost suporte-icone-botao"
                type="button"
                aria-label={mostrar ? 'Ocultar chave' : 'Mostrar chave'}
                data-tip={mostrar ? 'Ocultar chave' : 'Mostrar chave'}
                onClick={() => setMostrar((v) => !v)}
              >
                {mostrar ? <IconEyeOff size={15} aria-hidden="true" /> : <IconEye size={15} aria-hidden="true" />}
              </button>
              <button className="btn primary" type="submit" disabled={salvando || !chave.trim()}>
                Salvar chave
              </button>
              {trocando && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setTrocando(false)
                    setChave('')
                    setMostrar(false)
                  }}
                >
                  Cancelar
                </button>
              )}
            </form>
          ) : (
            <div className="settings-key-row">
              <span className="suporte-chave-salva">
                {temChave && <IconCheck size={14} aria-hidden="true" />}
                {temChave ? 'Chave salva' : 'Carregando…'}
              </span>
              {temChave && (
                <>
                  <button className="btn ghost" type="button" disabled={salvando} onClick={() => setTrocando(true)}>
                    Trocar
                  </button>
                  <button className="btn ghost" type="button" disabled={salvando} onClick={() => void apagarChave()}>
                    Apagar
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <form
          className="settings-field"
          onSubmit={(e) => {
            e.preventDefault()
            void salvar({ tecnico: nome }, 'Nome salvo.')
          }}
        >
          <label className="settings-field-label" htmlFor={idNome}>
            Seu Nome
          </label>
          <div className="settings-key-row">
            <input
              id={idNome}
              className="settings-input"
              type="text"
              name="nome-do-tecnico"
              value={nome}
              placeholder="Como o cliente vai ver você…"
              autoComplete="off"
              spellCheck={false}
              maxLength={SUPORTE_AJUSTES_LIMITES.tecnicoMax}
              disabled={!carregado}
              onChange={(e) => setNome(e.target.value)}
            />
            <button className="btn" type="submit" disabled={salvando || !nomeMudou}>
              Salvar
            </button>
          </div>
        </form>

        <div className="settings-field">
          <span className="settings-field-label">Link para o Cliente</span>
          <div className="settings-key-row">
            <span className="suporte-link" translate="no">
              {SUPORTE_LINK_CLIENTE}
            </span>
            <button
              className="btn suporte-icone-botao"
              type="button"
              aria-label="Copiar link"
              data-tip="Copiar link"
              onClick={() => void copiarLink()}
            >
              <IconCopy size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
