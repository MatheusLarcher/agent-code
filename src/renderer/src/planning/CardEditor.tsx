/**
 * Painel lateral de edição de card: título, tipo, etapa, fonte (sugestão),
 * selo (ambiguidade) e corpo em markdown com prévia (o Markdown do chat).
 *
 * Sem botão Salvar (cardDraft.ts): cada alteração vai para um rascunho em
 * cache e o arquivo é gravado quando o editor perde o foco (clique fora), ao
 * fechar, ao trocar de card e no unmount — só se algo mudou e se o card é
 * válido. 'Fechar' grava e fecha; se o card não pode ser gravado, mostra o
 * motivo e o segundo clique fecha deixando o texto no rascunho.
 *
 * '[[' no conteúdo abre as sugestões de card (CardRefSuggestions): a
 * referência entra pelo NOME, [[Título do card]], e vira seta no canvas; na
 * prévia aparece com a cor do tipo do card citado.
 */
import './cardEditor.css'
import { useMemo, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { PlanningCardDto } from '@shared/ipc'
import { Markdown } from '../components/Markdown'
import { CardRefSuggestions, useCardRefAutocomplete } from './CardRefSuggestions'
import { AMBIGUITY_STATUSES, CARD_TYPE_LABEL, CARD_TYPE_ORDER, TypeIcon } from './cardTypes'
import { TITLE_MAX, useCardAutosave, type CardAutosave, type CardFields } from './cardDraft'
import { isRefHref, makeRefResolver, refsToMarkdownLinks, type RefCard } from './cardRefs'
import type { SaveCardOutcome } from './usePlanning'

export { makeCardId } from './cardDraft'

export interface CardEditorProps {
  /** O card como foi aberto (ou a versão viva dele); card novo vem com id '' e rev 0. */
  card: PlanningCardDto
  isNew: boolean
  etapas: { id: string; titulo: string }[]
  /** Ids em uso, para o id do card novo não colidir. */
  existingIds: string[]
  /** Cards do plano: sugestões do '[[' e cores das referências na prévia. */
  cards?: readonly RefCard[]
  /** Projeto + plano: chave do rascunho em cache. */
  projectCwd?: string
  slug?: string
  onSave: (card: PlanningCardDto, expectedRev: number) => Promise<SaveCardOutcome>
  /** Cada gravação que deu certo (o card novo passa a ter id e rev). */
  onSaved?: (card: PlanningCardDto) => void
  /** Quem recebe confirma; true = apagado. */
  onDelete?: (card: PlanningCardDto) => Promise<boolean | void> | boolean | void
  onClose: () => void
  notify?: (tipo: 'aviso' | 'erro', msg: string) => void
}

const NO_CARDS: readonly RefCard[] = []

function statusText(a: CardAutosave): string {
  if (a.status === 'saving') return 'Gravando…'
  if (a.status === 'gone') return 'Card apagado fora daqui — o texto está no rascunho'
  if (a.status === 'invalid' || a.status === 'failed') return 'Não gravado — o texto está no rascunho'
  if (a.dirty) return 'Rascunho guardado · grava ao sair'
  return a.status === 'saved' ? 'Gravado' : 'Grava sozinho ao sair do card'
}

export function CardEditor({
  card,
  isNew,
  etapas,
  existingIds,
  cards = NO_CARDS,
  projectCwd = '',
  slug = '',
  onSave,
  onSaved,
  onDelete,
  onClose,
  notify
}: CardEditorProps): JSX.Element {
  const auto = useCardAutosave({ card, isNew, existingIds, projectCwd, slug, onSave, onSaved, notify })
  const { fields, base } = auto
  const [tab, setTab] = useState<'escrever' | 'previa'>('escrever')
  // Fechar com card que não grava: o 1º clique explica, o 2º fecha (o rascunho fica).
  const [closeArmed, setCloseArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const corpoRef = useRef<HTMLTextAreaElement>(null)

  function change<K extends keyof CardFields>(key: K, value: CardFields[K]): void {
    setCloseArmed(false)
    auto.setField(key, value)
  }

  const selfId = auto.persisted ? base.id : undefined
  const refs = useCardRefAutocomplete({
    cards,
    excludeId: selfId,
    value: fields.corpo,
    onChange: (text) => change('corpo', text),
    inputRef: corpoRef
  })
  const resolve = useMemo(() => makeRefResolver(cards), [cards])
  const previewText = useMemo(
    () => (tab === 'previa' ? refsToMarkdownLinks(fields.corpo, resolve) : ''),
    [tab, fields.corpo, resolve]
  )

  // Etapa que saiu do roteiro continua selecionável: trocar sozinho seria mudar o card sem pedir.
  const etapa = fields.etapa
  const etapaOptions = etapa && !etapas.some((e) => e.id === etapa) ? [...etapas, { id: etapa, titulo: `${etapa} (fora do roteiro)` }] : etapas
  const situacao = fields.status === 'resolvida' ? 'resolvida' : 'aberta'
  const isNewCard = !auto.persisted
  const outros = cards.filter((c) => c.id !== selfId).length

  async function close(): Promise<void> {
    if (busy) return
    if (closeArmed) return onClose()
    setBusy(true)
    const result = await auto.flush()
    setBusy(false)
    if (result === 'invalid' || result === 'failed') setCloseArmed(true)
    else onClose()
  }

  async function remove(): Promise<void> {
    if (!onDelete || busy) return
    auto.hold(true) // o foco vai para a confirmação: esse blur não grava
    setBusy(true)
    let deleted = false
    try {
      deleted = (await onDelete(base)) === true
    } finally {
      if (deleted) auto.forget()
      else {
        auto.hold(false)
        setBusy(false)
      }
    }
  }

  // Clique fora (o foco sai do painel): grava. Foco andando por dentro, não.
  function onBlur(e: FocusEvent<HTMLElement>): void {
    const to = e.relatedTarget as Node | null
    if (to && e.currentTarget.contains(to)) return
    void auto.flush()
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault()
    void auto.flush()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void auto.flush()
    }
  }

  // Referência na prévia é um link '#card-ref/…' só para ganhar cor: não navega.
  function onPreviewClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest?.('a')
    if (a && isRefHref(a.getAttribute('href'))) e.preventDefault()
  }

  return (
    // nokey: Delete/Backspace digitado aqui nunca apaga card no canvas.
    <aside
      className="pl-editor nokey"
      data-tipo={fields.tipo}
      role="dialog"
      aria-label={isNewCard ? 'Novo card' : 'Editar card'}
      tabIndex={-1}
      onBlur={onBlur}
    >
      <form className="pl-editor-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <header className="pl-editor-head">
          <h2>{isNewCard ? 'Novo card' : 'Editar card'}</h2>
          {!isNewCard && (
            <span className="pl-editor-id" title={`${base.id} · rev ${base.rev}`}>
              {base.id}
            </span>
          )}
          <button type="button" className="pl-editor-close" onClick={() => void close()} aria-label="Fechar editor" title="Fechar">
            ×
          </button>
        </header>

        <div className="pl-editor-body">
          {auto.restored && (
            <p className="pl-editor-restored" role="status">
              Reaplicado um rascunho que não tinha sido gravado.{' '}
              <button type="button" className="pl-link" onClick={auto.discardDraft}>
                Descartar
              </button>
            </p>
          )}

          <div className="pl-field">
            <label htmlFor="pl-ed-titulo">Título</label>
            <input
              id="pl-ed-titulo"
              className="pl-input"
              value={fields.titulo}
              maxLength={TITLE_MAX}
              autoFocus
              placeholder="O que este card registra?"
              onChange={(e) => change('titulo', e.target.value)}
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
                  aria-checked={fields.tipo === t}
                  data-tipo={t}
                  className={`pl-type${fields.tipo === t ? ' on' : ''}`}
                  onClick={() => change('tipo', t)}
                >
                  <TypeIcon tipo={t} size={13} />
                  {CARD_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="pl-field">
            <label htmlFor="pl-ed-etapa">Etapa</label>
            <select id="pl-ed-etapa" className="pl-select" value={etapa} onChange={(e) => change('etapa', e.target.value)}>
              <option value="">Sem etapa</option>
              {etapaOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.titulo || e.id}
                </option>
              ))}
            </select>
          </div>

          {fields.tipo === 'sugestao' && (
            <div className="pl-field">
              <label htmlFor="pl-ed-fonte">Fonte</label>
              <input
                id="pl-ed-fonte"
                className="pl-input"
                value={fields.fonte}
                spellCheck={false}
                placeholder="https://… ou src/arquivo.ts:12"
                aria-describedby="pl-ed-fonte-dica"
                onChange={(e) => change('fonte', e.target.value)}
              />
              <span className="pl-field-hint" id="pl-ed-fonte-dica">
                Link http(s) ou arquivo do projeto (caminho relativo, ":linha" opcional).
              </span>
            </div>
          )}

          {fields.tipo === 'ambiguidade' && (
            <div className="pl-field">
              <span className="pl-field-label">Situação</span>
              <div className="pl-seg" role="radiogroup" aria-label="Situação da ambiguidade">
                {AMBIGUITY_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={situacao === s}
                    className={situacao === s ? `on ${s}` : ''}
                    onClick={() => change('status', s)}
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
              <div className="pl-corpo">
                <textarea
                  id="pl-ed-corpo"
                  ref={corpoRef}
                  className="pl-textarea"
                  value={fields.corpo}
                  placeholder="Markdown. Digite [[ para citar outro card pelo nome."
                  {...refs.inputAria}
                  onChange={(e) => {
                    change('corpo', e.target.value)
                    refs.sync(e.target.value, e.target.selectionStart)
                  }}
                  onSelect={(e) => refs.sync(e.currentTarget.value, e.currentTarget.selectionStart)}
                  onKeyDown={(e) => void refs.handleKeyDown(e)}
                  onBlur={() => refs.close(false)}
                />
                {refs.open && (
                  <CardRefSuggestions
                    className="pl-editor-refs"
                    id={refs.listId}
                    items={refs.items}
                    active={refs.active}
                    onPick={refs.pick}
                    onActiveChange={refs.setActive}
                    emptyText={outros ? 'Nenhum card com esse nome' : 'Nenhum outro card no plano'}
                  />
                )}
              </div>
            ) : (
              <div className="pl-preview" onClick={onPreviewClick} onAuxClick={onPreviewClick}>
                {fields.corpo.trim() ? <Markdown text={previewText} /> : <p className="pl-preview-empty">Nada escrito ainda.</p>}
              </div>
            )}
          </div>

          {auto.erro && (
            <p className="pl-editor-error" role="alert">
              {auto.erro}
            </p>
          )}
        </div>

        <footer className="pl-editor-foot">
          {!isNewCard && onDelete && (
            <button type="button" className="btn small ghost pl-danger" onClick={() => void remove()} disabled={busy}>
              Apagar
            </button>
          )}
          <span className="pl-autosave" data-status={auto.status} aria-live="polite">
            {statusText(auto)}
          </span>
          <span className="pl-spacer" />
          <button type="button" className="btn small" onClick={() => void close()} disabled={busy}>
            {closeArmed ? 'Fechar mesmo assim' : 'Fechar'}
          </button>
        </footer>
      </form>
    </aside>
  )
}
