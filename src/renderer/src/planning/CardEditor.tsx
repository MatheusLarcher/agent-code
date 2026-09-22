/**
 * Painel lateral de edição de card: título, tipo, etapa, fonte (sugestão),
 * selo (ambiguidade) e corpo em markdown com prévia (o Markdown do chat).
 *
 * O `expectedRev` enviado ao salvar é o rev do card COMO FOI ABERTO — se o
 * agente mudar o card enquanto o painel está aberto, a gravação volta
 * 'rev_conflict' em vez de atropelar a versão nova.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PlanningCardDto, PlanningCardType } from '@shared/ipc'
import { Markdown } from '../components/Markdown'
import { AMBIGUITY_STATUSES, CARD_TYPE_LABEL, CARD_TYPE_ORDER, TypeIcon } from './cardTypes'

export interface CardEditorProps {
  /** O card como foi aberto; card novo vem com id '' e rev 0. */
  card: PlanningCardDto
  isNew: boolean
  etapas: { id: string; titulo: string }[]
  /** Ids em uso, para o id do card novo não colidir. */
  existingIds: string[]
  onSave: (card: PlanningCardDto, expectedRev: number) => Promise<unknown> | void
  onDelete?: (card: PlanningCardDto) => void
  onCancel: () => void
}

const TITLE_MAX = 1000

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Id [a-z0-9-] a partir do título, único entre `existing`. */
export function makeCardId(titulo: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const base =
    titulo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'card'
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`
    if (!taken.has(id)) return id
  }
  return `${base}-${Date.now().toString(36)}`
}

export function CardEditor({ card, isNew, etapas, existingIds, onSave, onDelete, onCancel }: CardEditorProps): JSX.Element {
  // Congelado na abertura: é o rev que o disco precisa ter para a gravação valer.
  const [openedRev] = useState(card.rev)
  const [titulo, setTitulo] = useState(card.titulo)
  const [tipo, setTipo] = useState<PlanningCardType>(card.tipo)
  const [etapa, setEtapa] = useState(card.etapa ?? '')
  const [fonte, setFonte] = useState(card.fonte ?? '')
  const [status, setStatus] = useState(card.status === 'resolvida' ? 'resolvida' : 'aberta')
  const [corpo, setCorpo] = useState(card.corpo)
  const [tab, setTab] = useState<'escrever' | 'previa'>('escrever')
  const [erro, setErro] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Etapa que saiu do roteiro continua selecionável: trocar sozinho seria mudar o card sem pedir.
  const etapaOptions = etapa && !etapas.some((e) => e.id === etapa) ? [...etapas, { id: etapa, titulo: `${etapa} (fora do roteiro)` }] : etapas

  function build(): PlanningCardDto | string {
    const t = titulo.trim()
    if (!t) return 'Dê um título ao card.'
    if (t.length > TITLE_MAX) return `Título longo demais (máximo ${TITLE_MAX} caracteres).`
    const f = fonte.trim()
    if (tipo === 'sugestao' && !isHttpUrl(f)) return 'Sugestão precisa de uma fonte: um link http(s).'
    const next: PlanningCardDto = {
      id: isNew ? makeCardId(t, existingIds) : card.id,
      tipo,
      titulo: t,
      links: card.links,
      rev: card.rev,
      corpo
    }
    if (etapa) next.etapa = etapa
    if (tipo === 'ambiguidade') next.status = status
    else if (card.tipo !== 'ambiguidade' && card.status) next.status = card.status
    if (tipo === 'sugestao') next.fonte = f
    else if (card.fonte) next.fonte = card.fonte
    return next
  }

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    if (saving) return
    const next = build()
    if (typeof next === 'string') {
      setErro(next)
      return
    }
    setErro(null)
    setSaving(true)
    try {
      await onSave(next, openedRev)
    } finally {
      setSaving(false)
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    // nokey: Delete/Backspace digitado aqui nunca apaga card no canvas.
    <aside className="pl-editor nokey" data-tipo={tipo} role="dialog" aria-label={isNew ? 'Novo card' : 'Editar card'}>
      <form className="pl-editor-form" onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
        <header className="pl-editor-head">
          <h2>{isNew ? 'Novo card' : 'Editar card'}</h2>
          {!isNew && (
            <span className="pl-editor-id" title={`${card.id} · rev ${openedRev}`}>
              {card.id}
            </span>
          )}
          <button type="button" className="pl-editor-close" onClick={onCancel} aria-label="Fechar editor" title="Fechar">
            ×
          </button>
        </header>

        <div className="pl-editor-body">
          <div className="pl-field">
            <label htmlFor="pl-ed-titulo">Título</label>
            <input
              id="pl-ed-titulo"
              className="pl-input"
              value={titulo}
              maxLength={TITLE_MAX}
              autoFocus
              placeholder="O que este card registra?"
              onChange={(e) => setTitulo(e.target.value)}
            />
          </div>

          <div className="pl-field">
            <span className="pl-field-label" id="pl-ed-tipo">
              Tipo
            </span>
            <div className="pl-types" role="radiogroup" aria-labelledby="pl-ed-tipo">
              {CARD_TYPE_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tipo === t}
                  data-tipo={t}
                  className={`pl-type${tipo === t ? ' on' : ''}`}
                  onClick={() => setTipo(t)}
                >
                  <TypeIcon tipo={t} size={13} />
                  {CARD_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="pl-field">
            <label htmlFor="pl-ed-etapa">Etapa</label>
            <select id="pl-ed-etapa" className="pl-select" value={etapa} onChange={(e) => setEtapa(e.target.value)}>
              <option value="">Sem etapa</option>
              {etapaOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.titulo || e.id}
                </option>
              ))}
            </select>
          </div>

          {tipo === 'sugestao' && (
            <div className="pl-field">
              <label htmlFor="pl-ed-fonte">Fonte</label>
              <input
                id="pl-ed-fonte"
                className="pl-input"
                type="url"
                value={fonte}
                placeholder="https://… (de onde veio a sugestão)"
                onChange={(e) => setFonte(e.target.value)}
              />
            </div>
          )}

          {tipo === 'ambiguidade' && (
            <div className="pl-field">
              <span className="pl-field-label">Situação</span>
              <div className="pl-seg" role="radiogroup" aria-label="Situação da ambiguidade">
                {AMBIGUITY_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={status === s}
                    className={status === s ? `on ${s}` : ''}
                    onClick={() => setStatus(s)}
                  >
                    {s === 'aberta' ? 'Aberta' : 'Resolvida'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pl-field pl-field-grow">
            <div className="pl-field-row">
              <label htmlFor="pl-ed-corpo">Conteúdo</label>
              <div className="pl-seg small" role="tablist" aria-label="Modo do conteúdo">
                <button type="button" role="tab" aria-selected={tab === 'escrever'} className={tab === 'escrever' ? 'on' : ''} onClick={() => setTab('escrever')}>
                  Escrever
                </button>
                <button type="button" role="tab" aria-selected={tab === 'previa'} className={tab === 'previa' ? 'on' : ''} onClick={() => setTab('previa')}>
                  Prévia
                </button>
              </div>
            </div>
            {tab === 'escrever' ? (
              <textarea
                id="pl-ed-corpo"
                className="pl-textarea"
                value={corpo}
                placeholder="Markdown. Use [[id]] para citar outro card."
                onChange={(e) => setCorpo(e.target.value)}
              />
            ) : (
              <div className="pl-preview">
                {corpo.trim() ? <Markdown text={corpo} /> : <p className="pl-preview-empty">Nada escrito ainda.</p>}
              </div>
            )}
          </div>

          {erro && (
            <p className="pl-editor-error" role="alert">
              {erro}
            </p>
          )}
        </div>

        <footer className="pl-editor-foot">
          {!isNew && onDelete && (
            <button type="button" className="btn small ghost pl-danger" onClick={() => onDelete(card)} disabled={saving}>
              Apagar
            </button>
          )}
          <span className="pl-kbd">Ctrl+Enter salva</span>
          <span className="pl-spacer" />
          <button type="button" className="btn small ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="btn small primary" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </footer>
      </form>
    </aside>
  )
}
