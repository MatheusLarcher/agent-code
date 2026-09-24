/**
 * Mídia do plano aberto, do lado da tela: importar (arrastado, colado ou pelo
 * "Anexar arquivo…"), criar card `midia` ou anexar a um card, e abrir um
 * anexo no app padrão do sistema.
 *
 * planning:importMedia não dispara planning:changed (o main registra a
 * gravação como própria): a resposta entra em plan.media por addMedia e o
 * card é gravado aqui mesmo, pelo saveCard do usePlanning. Todo sucesso e
 * toda falha viram toast — saveCard já avisa as falhas dele.
 */
import { useCallback, useRef } from 'react'
import type { OpenedPlanningDto, PlanningCardDto, PlanningFailure, PlanMediaDto } from '@shared/ipc'
import type { ToastType } from '../ui/UiProvider'
import type { Point } from './layout'
import { buildImport, mediaCard, openTarget, withAnexos, type DropTarget, type DroppedFile } from './mediaDrop'
import { displayName } from './mediaView'
import type { SaveCardOutcome } from './usePlanning'

export interface PlanMediaOptions {
  projectCwd: string
  slug: string
  plan: OpenedPlanningDto | null
  saveCard: (card: PlanningCardDto, expectedRev: number) => Promise<SaveCardOutcome>
  saveLayout: (positions: Record<string, Point>) => void
  addMedia: (media: PlanMediaDto[]) => void
  notify: (tipo: ToastType, msg: string) => void
}

export interface PlanMediaController {
  /** Copia os arquivos para <plano>/midia/; null se nada entrou (o toast já saiu). */
  importFiles: (files: readonly DroppedFile[]) => Promise<PlanMediaDto[] | null>
  /** Soltar/colar no canvas: cria card de mídia (área vazia) ou anexa (em cima de um card). */
  dropFiles: (files: readonly DroppedFile[], target: DropTarget) => Promise<void>
  /** Abre o anexo no app padrão (arquivo executável: abre a pasta). */
  openMedia: (name: string) => Promise<void>
}

function failText(res: PlanningFailure | { ok: false; message?: string }): string {
  return ('message' in res && res.message) || 'erro desconhecido'
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace('#', String(n))
}

export function usePlanMedia(opts: PlanMediaOptions): PlanMediaController {
  const ref = useRef(opts)
  ref.current = opts

  const importFiles = useCallback(async (files: readonly DroppedFile[]): Promise<PlanMediaDto[] | null> => {
    const { projectCwd, slug, addMedia, notify } = ref.current
    if (!files.length) return null
    const pathOf = (f: DroppedFile): string => window.api.getPathForFile?.(f as unknown as File) ?? ''
    let plan
    try {
      plan = await buildImport(files, pathOf)
    } catch (err) {
      notify('erro', `Não consegui ler o arquivo: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (plan.skipped.length) notify('aviso', `Ficou de fora — ${plan.skipped.join(' · ')}`)
    if (!plan.files.length) return null
    let res
    try {
      res = await window.api.planningImportMedia({ projectCwd, slug, files: plan.files })
    } catch (err) {
      notify('erro', `Não consegui importar: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (!res?.ok) {
      notify('erro', `Não consegui importar: ${res ? failText(res) : 'sem resposta'}`)
      return null
    }
    addMedia(res.media)
    return res.media
  }, [])

  const dropFiles = useCallback(
    async (files: readonly DroppedFile[], target: DropTarget): Promise<void> => {
      const media = await importFiles(files)
      if (!media?.length) return
      const { plan, saveCard, saveLayout, notify } = ref.current
      const names = media.map((m) => m.name)
      const existing = target.kind === 'card' ? plan?.cards.find((c) => c.id === target.cardId) : undefined
      if (existing) {
        const { card, added, dropped } = withAnexos(existing, names)
        if (dropped) notify('aviso', `"${existing.titulo}" já tem o máximo de anexos — ${plural(dropped, '1 arquivo ficou', '# arquivos ficaram')} só na pasta midia/`)
        if (!added) return
        const out = await saveCard(card, existing.rev)
        if (out.ok) notify('sucesso', `${plural(added, 'Arquivo anexado', '# arquivos anexados')} a "${existing.titulo}"`)
        return
      }
      const etapa = target.kind === 'empty' ? target.etapa : undefined
      const card = mediaCard(media, plan?.cards.map((c) => c.id) ?? [], etapa)
      const out = await saveCard(card, 0)
      if (!out.ok) return
      if (target.kind === 'empty') saveLayout({ [out.card.id]: target.position })
      notify('sucesso', `Card de mídia "${out.card.titulo}" criado`)
    },
    [importFiles]
  )

  const openMedia = useCallback(async (name: string): Promise<void> => {
    const { plan, notify } = ref.current
    const media = plan?.media?.find((m) => m.name === name)
    if (!media) {
      notify('aviso', `${displayName(name)} não está na pasta midia/ do plano`)
      return
    }
    const { path, folder } = openTarget(media.path)
    try {
      const r = await window.api.openInFolder(path)
      if (!r.ok) notify('erro', r.message)
      else if (folder) notify('aviso', `${displayName(name)} é um programa: abri a pasta dele em vez de executá-lo`)
    } catch (err) {
      notify('erro', `Não consegui abrir ${displayName(name)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  return { importFiles, dropFiles, openMedia }
}
