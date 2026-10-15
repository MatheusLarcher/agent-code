/**
 * A amostra de uma memória na lista do turno: parar o mouse (ou focar pelo
 * teclado) no nome abre, em SHOW_MS, um balão com caminho, título, gancho e o
 * começo do corpo. O texto vem do IPC só de leitura do painel de Memórias
 * (`memoryReadEntry`), que já devolve os segredos como `{{secret:…}}` — o valor
 * do cofre nunca chega aqui. Sem `title` nativo: o balão é nosso e dá para
 * entrar nele com o mouse para rolar.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const SHOW_MS = 150
const HIDE_MS = 120
const MAX_CHARS = 600
const GAP = 6
const EDGE = 6

export type MemoryPreview =
  | { status: 'ok'; relPath: string; title: string; hook: string; text: string }
  | { status: 'missing' }
  | { status: 'error' }

/** Texto simples do corpo: sem frontmatter, sem marcação de título/negrito, cortado em `max`. */
export function previewText(body: string, title = '', max = MAX_CHARS): string {
  let text = body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  text = text.replace(/\r\n/g, '\n').replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1')
  const lines = text.split('\n')
  // O primeiro título repete o título da memória: sai.
  while (lines.length && !lines[0].trim()) lines.shift()
  if (title && lines[0]?.trim().toLowerCase() === title.trim().toLowerCase()) lines.shift()
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/** Leitor com cache por relPath (vive com o cartão); erro não fica no cache. */
export function useMemoryPreviewReader(): (relPath: string) => Promise<MemoryPreview> {
  const cache = useRef(new Map<string, Promise<MemoryPreview>>())
  return useCallback((relPath: string) => {
    const hit = cache.current.get(relPath)
    if (hit) return hit
    const read = typeof window !== 'undefined' ? window.api?.memoryReadEntry : undefined
    const job: Promise<MemoryPreview> = (async (): Promise<MemoryPreview> => {
      if (typeof read !== 'function') return { status: 'error' }
      const r = await read(relPath)
      if (!r) return { status: 'missing' }
      const title = r.title?.trim() ?? ''
      return { status: 'ok', relPath: r.relPath, title, hook: r.hook?.trim() ?? '', text: previewText(r.body ?? '', title) }
    })().catch((): MemoryPreview => ({ status: 'error' }))
    cache.current.set(relPath, job)
    void job.then((p) => { if (p.status === 'error') cache.current.delete(relPath) })
    return job
  }, [])
}

interface Place { left: number; top: number; maxHeight: number }

export function ChatMemoryPreview({ relPath, read, children }: { relPath: string; read: (relPath: string) => Promise<MemoryPreview>; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<MemoryPreview | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const clear = (): void => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const show = (): void => {
    clear()
    timer.current = setTimeout(() => {
      setOpen(true)
      // Falha anterior não fica na tela: volta a "Carregando…" e tenta de novo.
      setData((d) => (d?.status === 'error' ? null : d))
      void read(relPath).then(setData)
    }, SHOW_MS)
  }
  // Pequena folga para o mouse atravessar até o balão e rolar o texto.
  const hide = (): void => { clear(); timer.current = setTimeout(() => setOpen(false), HIDE_MS) }
  const hideNow = (): void => { clear(); setOpen(false) }
  useEffect(() => clear, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hideNow() }
    const onScroll = (e: Event): void => { if (!(e.target instanceof Node && bubble.current?.contains(e.target))) hideNow() }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', hideNow)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', hideNow)
    }
  }, [open])

  // Abaixo do nome; sem espaço, acima. Sempre dentro da janela.
  useLayoutEffect(() => {
    const a = anchor.current
    const b = bubble.current
    if (!open || !a || !b) return setPlace(null)
    const r = a.getBoundingClientRect()
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const w = b.offsetWidth
    const h = b.scrollHeight
    const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - w - EDGE))
    const roomBelow = vh - r.bottom - GAP - EDGE
    const roomAbove = r.top - GAP - EDGE
    const below = roomBelow >= Math.min(h, 220) || roomBelow >= roomAbove
    const maxHeight = Math.max(80, Math.min(320, below ? roomBelow : roomAbove))
    const top = below ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - Math.min(h, maxHeight))
    setPlace({ left, top, maxHeight })
  }, [open, data])

  const body = !data ? <p className="chat-memory-preview-note">Carregando…</p>
    : data.status === 'missing' ? <p className="chat-memory-preview-note">Esta memória não existe mais.</p>
      : data.status === 'error' ? <p className="chat-memory-preview-note">Não foi possível ler a memória.</p>
        : <>
          {data.title && <strong>{data.title}</strong>}
          {data.hook && <p className="chat-memory-preview-hook">{data.hook}</p>}
          {data.text ? <p className="chat-memory-preview-body">{data.text}</p> : <p className="chat-memory-preview-note">Memória sem texto.</p>}
        </>

  return <>
    <span ref={anchor} className="chat-memory-name" tabIndex={0} aria-describedby={open ? id : undefined}
      onPointerEnter={(e) => { if (e.pointerType !== 'touch') show() }} onPointerLeave={hide} onFocus={show} onBlur={hideNow}>
      {children}
    </span>
    {open && typeof document !== 'undefined' && createPortal(
      <div ref={bubble} id={id} role="tooltip" className={`chat-memory-preview${place ? ' on' : ''}`}
        style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: -9999, top: -9999 }}
        onPointerEnter={clear} onPointerLeave={hide}>
        <small className="chat-memory-preview-path">{relPath}</small>
        {body}
      </div>,
      document.body
    )}
  </>
}
