import { useId, useRef, useState, type FormEvent } from 'react'
import { SUPORTE_LIMITES, formatarCodigoSuporte, type SuporteRecurso } from '@shared/suporteRemoto'
import { IconHeadset, IconSpinner, IconWarning } from '../components/Icons'
import { suporteApi, useSuporteRemoto } from './useSuporteRemoto'
import './suporteRemoto.css'

const DIGITOS = SUPORTE_LIMITES.codigoDigitos
/** Recursos extras que o cliente liberou, como o técnico os conhece. */
const NOME_DO_RECURSO: Partial<Record<SuporteRecurso, string>> = { chrome: 'Chrome', celular: 'Celular' }

/**
 * Faixa do suporte remoto no topo da conversa. Com o recurso ativado e sem sessão, é o
 * campo do código (conectar sem digitar no chat); na conversa dona da sessão, mostra o
 * estado e o Encerrar. Nas outras conversas some: a sessão é uma só e pertence a uma.
 */
export function SuporteRemotoFaixa({ convId }: { convId: string }): JSX.Element | null {
  const { ajustes, status } = useSuporteRemoto()
  const [codigo, setCodigo] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const campo = useRef<HTMLInputElement>(null)
  const idErro = useId()

  if (!ajustes?.ativado) return null
  const { estado } = status
  if (estado !== 'desligado' && status.convId !== convId) return null

  const conectar = async (evento: FormEvent): Promise<void> => {
    evento.preventDefault()
    const api = suporteApi()
    if (!api || ocupado) return
    if (codigo.length !== DIGITOS) {
      setErro(`O código tem ${DIGITOS} dígitos.`)
      campo.current?.focus()
      return
    }
    setErro(null)
    setOcupado(true)
    try {
      const resultado = await api.conectarSuporte(convId, codigo)
      if (resultado.ok) setCodigo('')
      // A recusa do cliente chega em toast (SuporteRemotoAvisos); o resto aparece aqui.
      else if (!resultado.avisado) setErro(resultado.mensagem)
    } catch {
      setErro('Não foi possível conectar. Tente de novo.')
    } finally {
      setOcupado(false)
    }
  }

  const encerrar = async (): Promise<void> => {
    const api = suporteApi()
    if (!api) return
    setErro(null)
    try {
      await api.desconectarSuporte()
    } catch {
      setErro('Não foi possível encerrar. Tente de novo.')
    }
  }

  const formulario = (
    <form className="suporte-faixa-form" onSubmit={(e) => void conectar(e)} noValidate>
      <input
        ref={campo}
        className="suporte-codigo"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        name="codigo-do-cliente"
        aria-label="Código do cliente"
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? idErro : undefined}
        placeholder="000 000 000…"
        value={formatarCodigoSuporte(codigo)}
        onChange={(e) => {
          setCodigo(e.target.value.replace(/\D/g, '').slice(0, DIGITOS))
          setErro(null)
        }}
      />
      <button className="btn primary suporte-faixa-botao" type="submit" disabled={ocupado}>
        Conectar
      </button>
    </form>
  )

  const recursos = Object.entries(status.recursos ?? {})
    .filter(([recurso, situacao]) => situacao === 'ligado' && recurso in NOME_DO_RECURSO)
    .map(([recurso]) => NOME_DO_RECURSO[recurso as SuporteRecurso] as string)

  return (
    <div className="suporte-faixa" data-estado={estado}>
      <span className="suporte-faixa-icone" aria-hidden="true">
        {estado === 'caiu' ? <IconWarning size={15} /> : <IconHeadset size={15} />}
      </span>
      <div className="suporte-faixa-corpo">
        {estado === 'desligado' && <strong className="suporte-faixa-titulo">Suporte Remoto</strong>}
        {/* O estado é anunciado com calma; o erro, ao lado, na hora (role="alert"). */}
        <span className="suporte-faixa-estado" role="status" aria-live="polite">
          {estado === 'conectando' && (
            <span className="suporte-faixa-texto">
              <IconSpinner className="spinner" size={13} aria-hidden="true" /> Conectando…
            </span>
          )}
          {estado === 'aguardando' && (
            <span className="suporte-faixa-texto">
              <IconSpinner className="spinner" size={13} aria-hidden="true" /> Aguardando o cliente permitir…
            </span>
          )}
          {estado === 'conectado' && (
            <span className="suporte-faixa-texto">
              <span className="suporte-ponto" aria-hidden="true" />
              <span className="suporte-faixa-pc">
                Conectado a <strong translate="no">{status.pc || 'computador do cliente'}</strong>
              </span>
              {status.admin && <span className="suporte-tag">Administrador</span>}
              {recursos.map((nome) => (
                <span className="suporte-tag" key={nome}>
                  {nome}
                </span>
              ))}
            </span>
          )}
          {estado === 'caiu' && <span className="suporte-faixa-texto">A conexão com o cliente caiu.</span>}
        </span>
        {erro && (
          <span className="suporte-faixa-erro" id={idErro} role="alert">
            {erro}
          </span>
        )}
      </div>
      {(estado === 'desligado' || estado === 'caiu') && formulario}
      {(estado === 'conectando' || estado === 'aguardando') && (
        <button className="btn suporte-faixa-botao" type="button" onClick={() => void encerrar()}>
          Cancelar
        </button>
      )}
      {estado === 'conectado' && (
        <button className="btn suporte-faixa-botao" type="button" onClick={() => void encerrar()}>
          Encerrar
        </button>
      )}
      {estado === 'caiu' && (
        <button className="btn ghost suporte-faixa-botao" type="button" onClick={() => void encerrar()}>
          Dispensar
        </button>
      )}
    </div>
  )
}
