import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { printsByCard, type BoardPrintImageResult, type BoardPrintMeta } from '@shared/boardPrints'
import { PrintsTag } from './BoardTagIcon'
import './boardPrints.css'

/**
 * Os PRINTS da tarefa visual (o agente anexa com `app_anexar_print`): o ícone
 * de câmera no cartão, as miniaturas no detalhe e o print grande no clique,
 * com a legenda e o horário.
 */

export type PrintsApi = Pick<AgentCodeApi, 'boardPrints' | 'boardPrintImage' | 'onBoardChanged'>

const appApi = (): PrintsApi | null => (window as unknown as { api?: PrintsApi }).api ?? null
const RELOAD_MS = 300

function usePrints(query: { projectCwd?: string; boardItemId?: string } | null, api: PrintsApi | null): BoardPrintMeta[] {
  const [prints, setPrints] = useState<BoardPrintMeta[]>([])
  const apiRef = useRef(api)
  apiRef.current = api
  const key = query ? `${query.projectCwd ?? ''}|${query.boardItemId ?? ''}` : ''
  useEffect(() => {
    const a = apiRef.current
    if (!query || !a || typeof a.boardPrints !== 'function') {
      setPrints([])
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void Promise.resolve(a.boardPrints(query))
        .then((res) => {
          if (alive && res?.available) setPrints(res.prints)
        })
        .catch(() => undefined)
    }
    load()
    // Print novo avisa como o resto do quadro (board:changed).
    const off =
      typeof a.onBoardChanged === 'function'
        ? a.onBoardChanged(() => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(load, RELOAD_MS)
          })
        : undefined
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      off?.()
    }
    // A consulta é a chave; o objeto muda a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return prints
}

/** Os prints do projeto, por cartão (o ícone de câmera do quadro). */
export function useProjectPrints(projectCwd: string | null, api: PrintsApi | null = appApi()): Map<string, BoardPrintMeta[]> {
  const prints = usePrints(projectCwd ? { projectCwd } : null, api)
  return useMemo(() => printsByCard(prints), [prints])
}

/** Câmera + N no cartão (o texto no tooltip). */
export function PrintBadge({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null
  return <PrintsTag count={count} />
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** O print grande: busca a imagem no clique; Esc ou clique fora fecha. */
export function PrintLightbox(props: { print: BoardPrintMeta; api?: PrintsApi | null; onClose(): void }): JSX.Element {
  const api = props.api === undefined ? appApi() : props.api
  const [image, setImage] = useState<BoardPrintImageResult | null>(null)
  const { print, onClose } = props
  useEffect(() => {
    let alive = true
    setImage(null)
    if (!api || typeof api.boardPrintImage !== 'function') {
      setImage({ ok: false, message: 'indisponível' })
      return
    }
    void Promise.resolve(api.boardPrintImage(print.id))
      .then((res) => alive && setImage(res))
      .catch((err: unknown) => alive && setImage({ ok: false, message: String(err) }))
    return () => {
      alive = false
    }
  }, [api, print.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="print-lightbox" role="dialog" aria-label="Print da tarefa" onClick={onClose}>
      <figure className="print-lightbox-body" onClick={(e) => e.stopPropagation()}>
        {image?.ok ? (
          <img src={image.url} alt={print.legenda ?? 'Print da tarefa'} />
        ) : (
          <img src={print.thumbUrl} alt={print.legenda ?? 'Print da tarefa'} className="loading" />
        )}
        <figcaption>
          <span>{print.legenda ?? 'Sem legenda'}</span>
          <span className="print-when">{fmtWhen(print.createdAt)}</span>
          {image && !image.ok ? <span className="print-error">Não consegui abrir o print grande: {image.message}</span> : null}
        </figcaption>
        <button type="button" className="nav-btn print-close" onClick={onClose} title="Fechar">
          ×
        </button>
      </figure>
    </div>
  )
}

/** As miniaturas no detalhe do cartão; o clique abre o print grande. */
export function CardPrints(props: { boardItemId: string; api?: PrintsApi | null }): JSX.Element | null {
  const api = props.api === undefined ? appApi() : props.api
  const prints = usePrints({ boardItemId: props.boardItemId }, api)
  const [open, setOpen] = useState<BoardPrintMeta | null>(null)
  if (prints.length === 0) return null
  return (
    <div className="card-prints" aria-label="Prints da tarefa">
      <div className="card-prints-title">Prints da tarefa testada</div>
      <div className="card-prints-row">
        {prints.map((p) => (
          <button type="button" key={p.id} className="card-print" onClick={() => setOpen(p)} title={p.legenda ?? 'Abrir o print'}>
            <img src={p.thumbUrl} alt={p.legenda ?? 'Print da tarefa'} />
            <span>{p.legenda ?? fmtWhen(p.createdAt)}</span>
          </button>
        ))}
      </div>
      {open && <PrintLightbox print={open} api={api} onClose={() => setOpen(null)} />}
    </div>
  )
}
