/**
 * "Reportar problema ou sugerir melhoria": o usuário escreve o que aconteceu
 * (ou a ideia) e o app abre uma issue já preenchida no GitHub do projeto, com
 * versão, Windows e modo da GPU anexados. Sem conta no GitHub, "Copiar texto"
 * deixa o relato pronto para mandar por qualquer canal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedbackDiagnostico } from '@shared/ipc'
import { feedbackIssueUrl, feedbackPlainText, type FeedbackInput, type FeedbackTipo } from './feedbackReport'
import { useUI } from './UiProvider'
import './feedback.css'

interface Props {
  onClose: () => void
  /** Para testes: diagnóstico fixo em vez do IPC. */
  carregarDiagnostico?: () => Promise<FeedbackDiagnostico>
}

const DICA: Record<FeedbackTipo, string> = {
  problema: 'O que você estava fazendo, o que esperava que acontecesse e o que aconteceu. Ex.: "Cliquei em Atualizar agora e o app fechou sem abrir de novo."',
  sugestao: 'O que você gostaria de fazer no app e por quê. Ex.: "Poder fixar uma conversa no topo da lista."'
}

const carregarPadrao = (): Promise<FeedbackDiagnostico> => window.api.feedbackDiagnostico()

export function FeedbackDialog({ onClose, carregarDiagnostico = carregarPadrao }: Props): JSX.Element {
  const { notify, confirm } = useUI()
  const [tipo, setTipo] = useState<FeedbackTipo>('problema')
  const [titulo, setTitulo] = useState('')
  const [descricao, setDescricao] = useState('')
  const [incluirTecnico, setIncluirTecnico] = useState(true)
  const [diagnostico, setDiagnostico] = useState<FeedbackDiagnostico | null>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    descRef.current?.focus()
    let vivo = true
    carregarDiagnostico()
      .then((d) => vivo && setDiagnostico(d))
      .catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [carregarDiagnostico])

  const temTexto = titulo.trim() !== '' || descricao.trim() !== ''

  const fechar = useCallback(async () => {
    if (temTexto) {
      const ok = await confirm({
        title: 'Descartar o relato?',
        message: 'O texto que você escreveu será perdido.',
        confirmLabel: 'Descartar',
        danger: true
      })
      if (!ok) return
    }
    onClose()
  }, [temTexto, confirm, onClose])

  useEffect(() => {
    // Captura: o Esc fecha só este modal, não as Configurações por trás.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      void fechar()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fechar])

  const entrada = (): FeedbackInput => ({ tipo, titulo, descricao, diagnostico: incluirTecnico ? diagnostico : null })

  const copiar = async (aviso = true): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(feedbackPlainText(entrada()))
      if (aviso) notify('sucesso', 'Relato copiado. Cole onde preferir para enviar.')
      return true
    } catch {
      if (aviso) notify('erro', 'Não deu para copiar. Selecione o texto e use Ctrl+C.')
      return false
    }
  }

  const enviar = async (): Promise<void> => {
    if (!descricao.trim()) {
      notify('aviso', tipo === 'problema' ? 'Descreva o problema antes de enviar.' : 'Descreva a sugestão antes de enviar.')
      descRef.current?.focus()
      return
    }
    const copiado = await copiar(false)
    const { url, cortado } = feedbackIssueUrl(entrada())
    window.open(url, '_blank')
    notify(
      'sucesso',
      cortado
        ? 'Abrimos o GitHub com parte do relato. O texto completo foi copiado: cole no fim e clique em "Create".'
        : `Abrimos o GitHub com o relato preenchido. Confira e clique em "Create".${copiado ? ' O texto também foi copiado.' : ''}`
    )
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={() => void fechar()}>
      <div
        className="modal-card feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title" id="feedback-title">
          Reportar problema ou sugerir melhoria
        </h3>

        <div className="feedback-tipo" role="radiogroup" aria-label="Tipo do relato">
          {(['problema', 'sugestao'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tipo === t}
              className={`feedback-tipo-opcao${tipo === t ? ' ativo' : ''}`}
              onClick={() => setTipo(t)}
            >
              {t === 'problema' ? 'Algo deu errado' : 'Tenho uma ideia'}
            </button>
          ))}
        </div>

        <label className="feedback-campo">
          <span>Resumo (opcional)</span>
          <input
            className="feedback-input"
            value={titulo}
            maxLength={120}
            placeholder={tipo === 'problema' ? 'Ex.: O app não abre depois da atualização' : 'Ex.: Fixar conversas no topo'}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </label>

        <label className="feedback-campo">
          <span>{tipo === 'problema' ? 'O que aconteceu' : 'Sua sugestão'}</span>
          <textarea
            ref={descRef}
            className="feedback-input feedback-texto"
            value={descricao}
            maxLength={8000}
            placeholder={DICA[tipo]}
            onChange={(e) => setDescricao(e.target.value)}
          />
        </label>

        <label className="feedback-check">
          <input type="checkbox" checked={incluirTecnico} onChange={(e) => setIncluirTecnico(e.target.checked)} />
          <span>
            Incluir informações técnicas
            <small>
              {diagnostico
                ? `Versão ${diagnostico.versao} · ${diagnostico.sistema} · vídeo ${diagnostico.gpu}. Nenhuma conversa, projeto ou senha vai junto.`
                : 'Versão do app, Windows e modo de vídeo. Nenhuma conversa, projeto ou senha vai junto.'}
            </small>
          </span>
        </label>

        <p className="feedback-nota">
          O envio abre o GitHub do Agent Code no navegador, com o relato pronto. Lá, é preciso entrar numa conta gratuita.
          Sem conta? Use Copiar texto e mande para quem te indicou o app.
        </p>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => void fechar()}>
            Cancelar
          </button>
          <button type="button" className="btn" onClick={() => void copiar()}>
            Copiar texto
          </button>
          <button type="button" className="btn primary" onClick={() => void enviar()}>
            Enviar pelo GitHub
          </button>
        </div>
      </div>
    </div>
  )
}
