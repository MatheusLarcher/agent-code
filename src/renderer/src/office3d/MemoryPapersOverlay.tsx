/**
 * Os papéis de memória de uma mesa (memoryPapers.ts), abertos pelo clique nas
 * folhas: a lista das memórias que o agente leu (o título do acervo —
 * memory:list-entries —, ou o caminho) e, ao clicar numa, a memória inteira
 * numa folha de papel, com o texto selecionável. "Abrir": o Explorador na pasta
 * de memórias com o arquivo selecionado (revealFile; o main valida); falha vira
 * aviso (notify). Esc (na captura: nem a tela do monitor nem o chat recebem) ou
 * ✕ fecha. O painel fica num canto: o escritório segue rodando e clicável.
 */
import './memoryPapers.css'
import { useContext, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import type { RevealFileRequest, RevealFileResult } from '@shared/ipc'
import type { MemoryListItem, MemoryReadResult } from '@shared/memoryPanel'
import type { OfficeFeed } from '../office/adapter/feed'
import { Markdown } from '../components/Markdown'
import { UiContext } from '../ui/UiProvider'
import type { Office3DEngine } from './engine'
import { memoryReadsOf } from './memoryPapers'

export interface MemoryPapersApi {
  memoryListEntries?(): Promise<MemoryListItem[]>
  memoryReadEntry?(relPath: string): Promise<MemoryReadResult | null>
  /** Só no PC (no celular a ponte não tem): sem ele, sem o "Abrir". */
  revealFile?(req: RevealFileRequest): Promise<RevealFileResult>
}
const appApi = (): MemoryPapersApi => (globalThis as { window?: { api?: MemoryPapersApi } }).window?.api ?? {}

export interface MemoryPapersOverlayProps {
  /** O agente dono da mesa (o nome no cabeçalho). */
  agent: string
  /** As memórias que ele leu (relPaths, na ordem da 1ª leitura). */
  reads: readonly string[]
  onClose: () => void
  /** A pasta de memórias (o caminho completo no hover do caminho); sem ela, só o relativo. */
  memoriesDir?: string | null
  /** Só testes: a api (padrão: window.api). */
  api?: MemoryPapersApi
}

/**
 * No Escritório: os papéis da mesa do agente `ownerKey` — o nome dele e as memórias que a
 * conversa dele leu (com a mesma pasta que montou as folhas, `scene.errands.memoriesDir`).
 */
export function OfficeMemoryPapers({ engine, feed, ownerKey, onClose }: { engine: Pick<Office3DEngine, 'scene'>; feed: OfficeFeed | null; ownerKey: string; onClose: () => void }): JSX.Element {
  const model = engine.scene.character(ownerKey)?.model
  const conv = feed?.conversations.find((c) => c.id === model?.convId)
  const reads = memoryReadsOf(feed, model?.convId, engine.scene.errands.memoriesDir)
  // O dono saiu do escritório (conversa fechada, filtro de projeto): o painel fecha sozinho.
  const gone = !!feed && !conv
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])
  if (gone) return <></>
  return <MemoryPapersOverlay key={ownerKey} agent={conv?.title || 'Agente'} reads={reads} memoriesDir={engine.scene.errands.memoriesDir} onClose={onClose} />
}

type Body ={ state: 'loading' } | { state: 'ok'; text: string } | { state: 'missing' } | { state: 'error' }

const REVEAL_FAIL = 'Não deu para abrir a pasta de memórias.'
/** O clique, a roda e a seleção no painel não descem para o escritório. */
const stop = (e: SyntheticEvent): void => e.stopPropagation()

export function MemoryPapersOverlay({ agent, reads, onClose, memoriesDir, api }: MemoryPapersOverlayProps): JSX.Element {
  const [a] = useState(() => api ?? appApi())
  const ui = useContext(UiContext)
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const [open, setOpen] = useState<string | null>(null)
  const [body, setBody] = useState<Body>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // Sem o aviso do app (fora do UiProvider), a falha do "Abrir" aparece na folha.
  const [note, setNote] = useState<string | null>(null)

  // Esc fecha só o painel (fase de captura); o `onClose` do render atual (quem chama pode passar uma função nova a cada render).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Com um modal do app aberto (permissão, pergunta, configurações…), o Esc é dele.
      if (e.key !== 'Escape' || document.querySelector('.modal-overlay')) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Os títulos do acervo, uma vez (sem eles, o caminho).
  useEffect(() => {
    let live = true
    void a.memoryListEntries?.().then(
      (list) => live && setTitles(new Map(list.map((i) => [i.relPath, i.title]))),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [a])

  // A memória aberta: o texto inteiro (null = não está no acervo).
  useEffect(() => {
    if (!open) return
    let live = true
    setBody({ state: 'loading' })
    setNote(null)
    void (a.memoryReadEntry?.(open) ?? Promise.resolve(null)).then(
      (r) => live && setBody(r ? { state: 'ok', text: r.body } : { state: 'missing' }),
      () => live && setBody({ state: 'error' })
    )
    return () => {
      live = false
    }
  }, [a, open, attempt])

  const reveal = async (relPath: string): Promise<void> => {
    setNote(null)
    const res = await a.revealFile!({ mode: 'folder', memory: relPath }).catch((): RevealFileResult => ({ ok: false, message: REVEAL_FAIL }))
    if (res.ok) return
    if (ui) ui.notify('erro', res.message || REVEAL_FAIL)
    else setNote(res.message || REVEAL_FAIL)
  }

  const title = (rel: string): string => titles.get(rel) ?? rel
  const fullPath = (rel: string): string => (memoriesDir ? `${memoriesDir.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}` : rel)
  return (
    <div className="o3d-mempapers" role="dialog" aria-label={`Memórias lidas por ${agent}`} data-testid="memory-papers" onPointerDown={stop} onWheel={stop} onDoubleClick={stop}>
      <header className="o3d-mempapers-head">
        {open ? (
          <button type="button" className="o3d-mempapers-btn" onClick={() => setOpen(null)}>
            ← Voltar para a lista
          </button>
        ) : (
          <div>
            <div className="o3d-mempapers-kicker">PAPÉIS NA MESA</div>
            <h3>{agent}</h3>
            <p className="o3d-mempapers-sub">
              {reads.length} memória{reads.length === 1 ? '' : 's'} lida{reads.length === 1 ? '' : 's'} nesta conversa
            </p>
          </div>
        )}
        <div className="o3d-mempapers-actions">
          {open && a.revealFile ? (
            <button type="button" className="o3d-mempapers-btn primary" onClick={() => void reveal(open)} title="Abrir a pasta de memórias com o arquivo selecionado">
              Abrir
            </button>
          ) : null}
          <button type="button" className="o3d-mempapers-close" onClick={onClose} aria-label="Fechar os papéis de memória" title="Fechar (Esc)">
            ✕
          </button>
        </div>
      </header>
      {open ? (
        <article className="o3d-mempaper" data-testid="memory-paper">
          <h2>{title(open)}</h2>
          {a.revealFile ? (
            <button type="button" className="o3d-mempaper-path o3d-mempaper-path-btn" onClick={() => void reveal(open)} title={`${fullPath(open)}\nClique para abrir na pasta`} data-testid="memory-paper-path">
              {open}
            </button>
          ) : (
            <p className="o3d-mempaper-path" title={fullPath(open)}>
              {open}
            </p>
          )}
          {note ? (
            <p className="o3d-mempaper-note" role="alert">
              {note}
            </p>
          ) : null}
          <div className="o3d-mempaper-body" data-testid="memory-paper-body">
            {body.state === 'ok' ? (
              <Markdown text={body.text} />
            ) : body.state === 'missing' ? (
              <p className="o3d-mempaper-muted">Esta memória não está mais no acervo (apagada ou movida).</p>
            ) : body.state === 'error' ? (
              <p className="o3d-mempaper-muted">
                Não deu para ler a memória.{' '}
                <button type="button" className="o3d-mempapers-link" onClick={() => setAttempt((n) => n + 1)}>
                  Tentar de novo
                </button>
              </p>
            ) : (
              <p className="o3d-mempaper-muted">Abrindo…</p>
            )}
          </div>
        </article>
      ) : (
        <ul className="o3d-mempapers-list">
          {reads.map((rel, i) => (
            <li key={rel}>
              <button type="button" className="o3d-mempapers-item" onClick={() => setOpen(rel)} data-testid="memory-papers-item">
                <span className="o3d-mempapers-n">{i + 1}</span>
                <span className="o3d-mempapers-title">{title(rel)}</span>
                {titles.has(rel) ? <span className="o3d-mempapers-path">{rel}</span> : null}
              </button>
            </li>
          ))}
          {!reads.length ? <li className="o3d-mempaper-muted">Nenhuma memória lida nesta conversa.</li> : null}
        </ul>
      )}
    </div>
  )
}
