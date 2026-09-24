import path from 'node:path'
import { MAX_ANEXOS_POR_CARD, MEDIA_DIR } from '../../shared/planningMedia'
import type * as realMedia from './planningMedia'
import type { PlanCard } from './planningModel'
import { RevConflictError, type OpenedPlan } from './planningStore'
import {
  cardHeader,
  describeCard,
  describeError,
  formatSize,
  mediaIndexOf,
  mediaLine,
  text,
  type MediaIndex,
  type ToolBlock,
  type ToolText
} from './planningToolText'

/**
 * A parte de mídia das ferramentas plan_* (planningTools.ts): anexos no
 * plan_read, validação de `anexos` e o plan_midia_importar. Nada aqui toca o
 * disco direto — lê e copia pelo planningMedia (injetável para teste) e grava o
 * card pelo store.
 */

export type PlanningToolMedia = Pick<typeof realMedia, 'importMedia' | 'listMedia' | 'readMedia'>

/** Formatos que vão ao Manager como bloco de imagem (os que a API aceita). */
export const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const MAX_IMAGE_BLOCKS = 4
export const MAX_IMAGE_BLOCK_BYTES = 5 * 1024 * 1024

export interface MediaToolDeps {
  projectCwd: string
  slug: string
  media: PlanningToolMedia
  open: () => Promise<OpenedPlan>
  saveCard: (card: PlanCard, expectedRev: number) => Promise<PlanCard>
  changed: () => void
}

export async function loadMediaIndex(deps: MediaToolDeps, plan: OpenedPlan): Promise<MediaIndex> {
  return mediaIndexOf(path.join(plan.dir, MEDIA_DIR), await deps.media.listMedia(deps.projectCwd, deps.slug))
}

/**
 * O card inteiro em texto e, logo depois, as imagens anexadas (png/jpeg/gif/
 * webp, até MAX_IMAGE_BLOCKS, cada uma até MAX_IMAGE_BLOCK_BYTES) como blocos
 * de imagem, cada uma precedida do nome. As que ficam de fora são citadas.
 */
export async function readCardWithMedia(deps: MediaToolDeps, card: PlanCard, index: MediaIndex): Promise<ToolText> {
  const images: ToolBlock[] = []
  const skipped: string[] = []
  let sent = 0
  for (const name of card.anexos ?? []) {
    const media = index.byName.get(name)
    if (!media || media.kind !== 'imagem') continue
    if (!IMAGE_BLOCK_TYPES.has(media.mediaType)) {
      skipped.push(`${name} (formato ${media.mediaType} não vai como imagem)`)
    } else if (media.size > MAX_IMAGE_BLOCK_BYTES) {
      skipped.push(`${name} (${formatSize(media.size)}, acima de ${formatSize(MAX_IMAGE_BLOCK_BYTES)})`)
    } else if (sent >= MAX_IMAGE_BLOCKS) {
      skipped.push(`${name} (limite de ${MAX_IMAGE_BLOCKS} imagens por leitura)`)
    } else {
      try {
        const content = await deps.media.readMedia(deps.projectCwd, deps.slug, name)
        images.push({ type: 'text', text: `Imagem anexada: ${name}` }, { type: 'image', data: content.base64, mimeType: content.mediaType })
        sent++
      } catch (error) {
        skipped.push(`${name} (não consegui ler: ${describeError(error)})`)
      }
    }
  }
  let head = describeCard(card, index)
  if (skipped.length) {
    head += `\n\nImagens que não vieram como imagem nesta leitura (abra com Read pelo caminho acima): ${skipped.join('; ')}.`
  }
  return { content: [{ type: 'text', text: head }, ...images] }
}

/**
 * Motivo de recusa de uma lista de anexos, ou null. Nome novo tem de existir
 * em midia/; nome que o card JÁ tinha passa mesmo sem o arquivo (o usuário pode
 * tê-lo apagado, e isso não deve travar outra alteração do card).
 */
export function anexosProblem(names: readonly string[], index: MediaIndex, alreadyOnCard: readonly string[] = []): string | null {
  const unique = [...new Set(names)]
  if (unique.length > MAX_ANEXOS_POR_CARD) return `no máximo ${MAX_ANEXOS_POR_CARD} anexos por card (vieram ${unique.length}).`
  const missing = unique.filter((name) => !alreadyOnCard.includes(name) && !index.byName.has(name))
  if (!missing.length) return null
  return (
    `anexos que não existem em midia/: ${missing.join(', ')}. Use o nome exato listado em "Mídias do plano" ` +
    '(plan_read) ou traga o arquivo com plan_midia_importar, que devolve o nome a usar.'
  )
}

/** anexosProblem contra o midia/ atual; sem anexos, nem lista a pasta. */
export async function anexosCheck(
  deps: MediaToolDeps,
  plan: OpenedPlan,
  names: readonly string[] | undefined,
  current?: PlanCard
): Promise<string | null> {
  if (!names?.length) return null
  return anexosProblem(names, await loadMediaIndex(deps, plan), current?.anexos)
}

export interface ImportArgs {
  caminho: string
  card_id?: string
  expected_rev?: number
}

/**
 * plan_midia_importar: copia `caminho` (absoluto, ou relativo à raiz do
 * projeto) para midia/ e, com card_id, anexa ao card. O card é conferido ANTES
 * da cópia (inexistente, rev errado ou cheio: nada é copiado); se ele mudar
 * entre a cópia e a gravação, a mídia fica em midia/ e a resposta diz isso.
 */
export async function importAndAttach(deps: MediaToolDeps, a: ImportArgs): Promise<ToolText> {
  let card: PlanCard | undefined
  if (a.card_id !== undefined) {
    if (a.expected_rev === undefined) {
      return text('Nada importado: para anexar ao card, informe expected_rev (o rev do card na sua última leitura com plan_read).')
    }
    card = (await deps.open()).cards.find((c) => c.id === a.card_id)
    if (!card) return text(`Nada importado: não existe card ${a.card_id}; veja plan_read. Sem card_id, a mídia só entra no plano.`)
    if (card.rev !== a.expected_rev) throw new RevConflictError(card, a.expected_rev)
    if ((card.anexos?.length ?? 0) >= MAX_ANEXOS_POR_CARD) {
      return text(`Nada importado: o card ${card.id} já tem ${MAX_ANEXOS_POR_CARD} anexos, o máximo. Tire algum com plan_card_update antes.`)
    }
  }
  const source = path.resolve(deps.projectCwd, a.caminho)
  const media = await deps.media.importMedia(deps.projectCwd, deps.slug, { path: source })
  const head = `Mídia importada: ${mediaLine(media)} · ${formatSize(media.size)}`
  if (!card) {
    deps.changed()
    return text(`${head}\nPara anexá-la a um card, ponha "${media.name}" em anexos (plan_card_create ou plan_card_update).`)
  }
  try {
    const saved = await deps.saveCard({ ...card, anexos: [...(card.anexos ?? []), media.name] }, card.rev)
    return text(`${head}\nAnexada ao card: ${cardHeader(saved)}`)
  } catch (error) {
    return text(
      `${head}\nMas NÃO foi anexada ao card ${card.id}: ${describeError(error)}\n` +
        `A mídia já está em midia/: para anexar, use plan_card_update com anexos incluindo "${media.name}".`
    )
  } finally {
    deps.changed()
  }
}
