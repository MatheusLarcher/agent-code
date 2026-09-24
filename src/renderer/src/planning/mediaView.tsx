/**
 * Como a mídia de um card aparece (no nó do canvas e no editor): imagem vira
 * miniatura, o resto vira etiqueta com ícone + tipo + nome.
 *
 * A miniatura vem de planning:readMedia (base64) e vira data URL — a CSP
 * aceita img-src data:. Fica num cache por projeto + plano + nome (o nome da
 * mídia é único: leva um prefixo aleatório), reduzida para MINIATURA_PX para
 * não guardar a foto inteira na memória por card. Falha não entra no cache:
 * mídia recém-importada ou reposta volta a ser tentada.
 */
import './planningMedia.css'
import { createContext, useContext, useEffect, useState } from 'react'
import type { PlanMediaDto } from '@shared/ipc'
import { MEDIA_KIND_LABEL, mediaKindOf, type MediaKind } from '@shared/planningMedia'

/** O plano aberto, para quem mostra mídia (CardNode não recebe isso pelos dados do nó). */
export interface PlanningMediaInfo {
  projectCwd: string
  slug: string
  media: readonly PlanMediaDto[]
}

export const PlanningMediaContext = createContext<PlanningMediaInfo | null>(null)

export function usePlanningMedia(): PlanningMediaInfo | null {
  return useContext(PlanningMediaContext)
}

/** Maior lado da miniatura guardada no cache. */
export const MINIATURA_PX = 320
const CACHE_MAX = 200
const cache = new Map<string, Promise<string | null>>()

function cacheKey(projectCwd: string, slug: string, name: string): string {
  return JSON.stringify([projectCwd.replace(/[\\/]+/g, '/').toLowerCase(), slug, name])
}

/** Esvazia o cache (testes). */
export function clearThumbCache(): void {
  cache.clear()
}

/** Reduz a imagem para caber em MINIATURA_PX; sem canvas (ou SVG), fica a original. */
async function shrink(dataUrl: string, mediaType: string): Promise<string> {
  if (mediaType === 'image/svg+xml') return dataUrl
  try {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const scale = Math.min(1, MINIATURA_PX / Math.max(img.naturalWidth, img.naturalHeight, 1))
    if (scale >= 1) return dataUrl
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = canvas.toDataURL('image/webp', 0.85)
    return out.startsWith('data:image/') ? out : dataUrl
  } catch {
    return dataUrl
  }
}

async function fetchThumb(projectCwd: string, slug: string, name: string): Promise<string | null> {
  try {
    const res = await window.api.planningReadMedia({ projectCwd, slug, name })
    if (!res?.ok || !res.mediaType.startsWith('image/')) return null
    return await shrink(`data:${res.mediaType};base64,${res.base64}`, res.mediaType)
  } catch {
    return null
  }
}

/** Data URL da miniatura (null = não deu: arquivo sumido, grande demais, não é imagem). */
export function loadThumb(projectCwd: string, slug: string, name: string): Promise<string | null> {
  const key = cacheKey(projectCwd, slug, name)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key) // LRU: volta para o fim
    cache.set(key, hit)
    return hit
  }
  const p = fetchThumb(projectCwd, slug, name).then((url) => {
    if (!url) cache.delete(key)
    return url
  })
  cache.set(key, p)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return p
}

/** 'loading' enquanto busca; a URL; ou null (mostra a etiqueta). */
export function useMediaThumb(name: string, enabled: boolean): string | null | 'loading' {
  const info = usePlanningMedia()
  const projectCwd = info?.projectCwd ?? ''
  const slug = info?.slug ?? ''
  const on = enabled && !!projectCwd && !!slug
  const [url, setUrl] = useState<string | null | 'loading'>(on ? 'loading' : null)
  useEffect(() => {
    if (!on) {
      setUrl(null)
      return
    }
    let alive = true
    setUrl('loading')
    void loadThumb(projectCwd, slug, name).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [on, projectCwd, slug, name])
  return url
}

/** "a1b2c3-tela-de-login.png" → "tela-de-login.png" (o prefixo é só para não colidir). */
export function displayName(name: string): string {
  return name.replace(/^[0-9a-f]{6}-/, '')
}

const KIND_PATHS: Record<MediaKind, JSX.Element> = {
  imagem: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  pdf: (
    <>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4M9 13h6M9 17h4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  planilha: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16" />
    </>
  ),
  documento: (
    <>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4M9 11h6M9 14h6M9 17h6" />
    </>
  ),
  apresentacao: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M12 16v4M8 20h8" />
    </>
  ),
  texto: (
    <>
      <path d="M4 6h16M4 10h16M4 14h10M4 18h7" />
    </>
  ),
  compactado: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M12 3v2M12 7v2M12 11v2M10.5 15h3v3h-3z" />
    </>
  ),
  outro: (
    <>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4" />
    </>
  )
}

export function MediaKindIcon({ kind, size = 14 }: { kind: MediaKind; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {KIND_PATHS[kind] ?? KIND_PATHS.outro}
    </svg>
  )
}

/** Tipo de um anexo: o que o main disse (plan.media) ou, sem isso, pela extensão. */
export function kindOfAnexo(name: string, media: readonly PlanMediaDto[] | undefined): MediaKind {
  return media?.find((m) => m.name === name)?.kind ?? mediaKindOf(name)
}

/** Etiqueta: ícone + tipo + nome. */
export function MediaChip({ name, kind, className = '' }: { name: string; kind: MediaKind; className?: string }): JSX.Element {
  const shown = displayName(name)
  return (
    <span className={`pl-media-chip ${className}`.trim()} title={`${MEDIA_KIND_LABEL[kind]}: ${shown}`}>
      <MediaKindIcon kind={kind} size={12} />
      <span className="pl-media-chip-kind">{MEDIA_KIND_LABEL[kind]}</span>
      <span className="pl-media-chip-name">{shown}</span>
    </span>
  )
}

/** Imagem vira miniatura; o resto (ou imagem que não carregou) vira etiqueta. */
export function MediaPreview({ name, className = '' }: { name: string; className?: string }): JSX.Element {
  const info = usePlanningMedia()
  const kind = kindOfAnexo(name, info?.media)
  const thumb = useMediaThumb(name, kind === 'imagem')
  if (kind === 'imagem' && thumb === 'loading') {
    return <span className={`pl-media-thumb loading ${className}`.trim()} aria-label={`Carregando ${displayName(name)}`} />
  }
  if (kind === 'imagem' && thumb) {
    return <img className={`pl-media-thumb ${className}`.trim()} src={thumb} alt={displayName(name)} title={displayName(name)} draggable={false} />
  }
  return <MediaChip name={name} kind={kind} className={className} />
}
