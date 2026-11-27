/**
 * A moldura do Preview: a fileira de abas internas e a barra com voltar,
 * avançar, recarregar, endereço, Selecionar e "Abrir fora do app".
 * Sem estado de abas aqui — tudo chega por props do PreviewPane.
 */
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import type { PreviewTab } from '@shared/preview'
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconExternal,
  IconFile,
  IconGlobe,
  IconPlus,
  IconPointer,
  IconRefresh
} from '../components/Icons'
import { extLabel } from './previewTabs'

interface StripProps {
  tabs: PreviewTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

/** Abas internas do Preview (uma por site/arquivo aberto). */
export function PreviewTabStrip({ tabs, activeId, onSelect, onClose, onNew }: StripProps): JSX.Element | null {
  if (tabs.length === 0) return null
  return (
    <div className="pp-tabs" role="tablist" aria-label="Abas do Preview">
      {tabs.map((t) => {
        const active = t.id === activeId
        const ext = extLabel(t.target)
        return (
          <div key={t.id} className={`pp-tab${active ? ' active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="pp-tab-main"
              data-tip={t.target}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                // Clique do meio fecha, como no navegador.
                if (e.button === 1) onClose(t.id)
              }}
            >
              {t.kind === 'web' ? <IconGlobe size={12} aria-hidden="true" /> : <IconFile size={12} aria-hidden="true" />}
              <span className="pp-tab-title">{t.title}</span>
              {ext && <span className="pp-tab-ext">{ext}</span>}
            </button>
            <button
              type="button"
              className="pp-tab-close"
              aria-label={`Fechar ${t.title}`}
              data-tip="Fechar aba"
              onClick={() => onClose(t.id)}
            >
              <IconClose size={11} aria-hidden="true" />
            </button>
          </div>
        )
      })}
      <button type="button" className="pp-icon-btn pp-tab-new" aria-label="Nova aba" data-tip="Nova aba" onClick={onNew}>
        <IconPlus size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

interface BarProps {
  tab: PreviewTab | null
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  /** O seletor só funciona em página (site ou html). */
  canPick: boolean
  picking: boolean
  onPickingChange: (on: boolean) => void
  /** Endereço digitado. false = não reconhecido (mostra o erro). */
  onSubmit: (raw: string) => boolean
  onOpenOutside: () => void
  addressRef: RefObject<HTMLInputElement | null>
}

export function PreviewToolbar(p: BarProps): JSX.Element {
  const target = p.tab?.target ?? ''
  const [draft, setDraft] = useState(target)
  const [error, setError] = useState(false)

  // A aba mudou (ou navegou): o campo mostra o endereço dela.
  useEffect(() => {
    setDraft(target)
    setError(false)
  }, [p.tab?.id, target])

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const ok = p.onSubmit(draft)
      setError(!ok)
      if (ok) e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      setDraft(target)
      setError(false)
    }
  }

  const hasTab = !!p.tab
  return (
    <div className="pp-bar-wrap">
      <div className="pp-bar">
        <button type="button" className="pp-icon-btn" aria-label="Voltar" data-tip="Voltar" disabled={!p.canBack} onClick={p.onBack}>
          <IconChevronLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pp-icon-btn"
          aria-label="Avançar"
          data-tip="Avançar"
          disabled={!p.canForward}
          onClick={p.onForward}
        >
          <IconChevronRight size={15} aria-hidden="true" />
        </button>
        <button type="button" className="pp-icon-btn" aria-label="Recarregar" data-tip="Recarregar" disabled={!hasTab} onClick={p.onReload}>
          <IconRefresh size={14} aria-hidden="true" />
        </button>
        <input
          ref={p.addressRef}
          className={`pp-address${error ? ' invalid' : ''}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label="Endereço: link do site ou caminho do arquivo"
          aria-invalid={error}
          placeholder="Cole um link (https://…) ou o caminho de um arquivo"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(false)
          }}
          onKeyDown={onKey}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className={`pp-pick${p.picking ? ' on' : ''}`}
          aria-pressed={p.picking}
          disabled={!p.canPick}
          data-tip={p.canPick ? 'Clique num trecho para mandar ao agente' : 'Abra uma página ou arquivo para selecionar'}
          onClick={() => p.onPickingChange(!p.picking)}
        >
          <IconPointer size={13} aria-hidden="true" />
          Selecionar
        </button>
        <button
          type="button"
          className="pp-icon-btn"
          aria-label="Abrir fora do app"
          data-tip="Abrir fora do app"
          disabled={!hasTab}
          onClick={p.onOpenOutside}
        >
          <IconExternal size={14} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p className="pp-address-error" role="alert">
          Endereço não reconhecido. Use um link (https://…) ou o caminho completo do arquivo (C:\…).
        </p>
      )}
    </div>
  )
}
