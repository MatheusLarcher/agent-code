/**
 * "Novidades": o que mudou em cada versão, em linguagem simples. Os textos
 * vêm de `src/shared/novidades.json` (o build carimba a versão nos itens de
 * "proxima"). Aberto pelo botão ao lado da versão, em Configurações.
 */
import { useEffect, useRef } from 'react'
import novidades from '@shared/novidades.json'

export interface NotaDeVersao {
  versao: string
  data: string
  itens: string[]
}

export const NOTAS: readonly NotaDeVersao[] = novidades.versoes

const MESES = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.']

/** "2026-11-19" → "19 de nov. de 2026"; data inválida volta como veio. */
export function fmtData(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1] ?? m[2]} de ${m[1]}`
}

interface Props {
  appVersion: string
  onClose: () => void
  notas?: readonly NotaDeVersao[]
}

export function NovidadesDialog({ appVersion, onClose, notas = NOTAS }: Props): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    // Captura: o Esc fecha só as Novidades, não o modal de Configurações por trás.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card novidades-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="novidades-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title" id="novidades-title">
          Novidades
        </h3>
        {notas.length === 0 ? (
          <p className="modal-message">Ainda não há novidades registradas.</p>
        ) : (
          <ol className="novidades-list">
            {notas.map((n) => {
              const atual = n.versao === appVersion
              return (
                <li key={n.versao} className={`novidades-item${atual ? ' atual' : ''}`}>
                  <div className="novidades-head">
                    <span className="novidades-versao">Versão {n.versao}</span>
                    {atual && <span className="novidades-tag">Sua versão</span>}
                    <span className="novidades-data">{fmtData(n.data)}</span>
                  </div>
                  <ul>
                    {n.itens.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ol>
        )}
        <div className="modal-actions">
          <button type="button" className="btn primary" ref={closeRef} onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
