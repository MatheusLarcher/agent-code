/**
 * Prompts ANTIGOS no "Enviar para implementação": gravados antes da última
 * mudança do plano (`_roteiro.md` ou `cards/*.md`) e ainda não enviados. Eles
 * não se misturam com os novos: ganham o selo, não entram no envio sem o
 * usuário incluí-los de propósito, e o aviso do topo oferece "Descartar os
 * antigos" — que pergunta antes e só MOVE para `_handoff/_descartados/` (os
 * arquivos continuam no disco; prompt já enviado nunca sai).
 */
import { useCallback, useMemo } from 'react'
import type { PlanningHandoffDto } from '@shared/ipc'
import { IconWarning } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { failureText, safe } from './handoffFlow'

export const STALE_LABEL = 'desatualizado — gravado antes da última mudança do plano'

export function StaleBadge(): JSX.Element {
  return <span className="pl-handoff-badge stale">{STALE_LABEL}</span>
}

export function staleTitle(count: number): string {
  return count === 1
    ? '1 prompt antigo, de antes da última mudança do plano'
    : `${count} prompts antigos, de antes da última mudança do plano`
}

/** O aviso do topo, com o botão que descarta (perguntando antes). */
export function StaleNotice(props: { count: number; disabled: boolean; onDiscard: () => void }): JSX.Element | null {
  if (props.count === 0) return null
  return (
    <section className="pl-handoff-issues warn pl-handoff-stale" aria-label="Prompts antigos">
      <h4>
        <IconWarning size={13} /> {staleTitle(props.count)}
      </h4>
      <div className="pl-handoff-stale-row">
        <p>Não entram no envio, a menos que você os inclua de propósito.</p>
        <button type="button" className="btn small" disabled={props.disabled} onClick={props.onDiscard}>
          Descartar os antigos
        </button>
      </div>
    </section>
  )
}

export interface StaleHandoffs {
  /** Os nomes dos antigos não enviados. */
  set: ReadonlySet<string>
  /** Quantos dos pendentes são antigos. */
  count: number
  /** Há antigo fora da revisão, à disposição para incluir de propósito. */
  staleOutside: boolean
  /** Só os que não são antigos. */
  fresh: (all: readonly PlanningHandoffDto[]) => PlanningHandoffDto[]
  /** "Descartar os antigos": pergunta e, confirmado, move. */
  discard: () => Promise<void>
  /** Antes do rascunho automático: a mesma conferência do plan_handoff_write. */
  beforeDraft: () => Promise<void>
}

export function useStaleHandoffs<D extends { name: string }>(args: {
  projectCwd: string
  slug: string
  /** Os antigos da última listagem (`PlanningHandoffListDto.stale`). */
  stale: readonly string[] | undefined
  pending: readonly PlanningHandoffDto[]
  outside: readonly PlanningHandoffDto[]
  /** As revisões do diálogo: o que foi descartado sai delas. */
  setDrafts: (update: (all: D[]) => D[]) => void
  /** Relista _handoff/ depois de descartar. */
  reload: () => void
}): StaleHandoffs {
  const { projectCwd, slug, setDrafts, reload } = args
  const { confirm, notify } = useUI()
  const set = useMemo(() => new Set(args.stale ?? []), [args.stale])
  const fresh = useCallback((all: readonly PlanningHandoffDto[]) => all.filter((h) => !set.has(h.name)), [set])
  const count = args.pending.length - fresh(args.pending).length

  const move = useCallback(async (): Promise<void> => {
    const res = await safe(() => window.api.planningDiscardHandoffs({ projectCwd, slug }))
    if (!res.ok) {
      notify('erro', `Não consegui descartar os prompts antigos: ${failureText(res)}`)
      return
    }
    setDrafts((all) => all.filter((d) => !res.discarded.includes(d.name)))
    reload()
    if (res.discarded.length > 0) {
      notify('sucesso', `${res.discarded.length === 1 ? '1 prompt antigo foi' : `${res.discarded.length} prompts antigos foram`} para _handoff/_descartados/.`)
    }
  }, [projectCwd, slug, notify, setDrafts, reload])

  const discard = useCallback(async (): Promise<void> => {
    if (count === 0) return
    const ok = await confirm({
      title: 'Descartar os prompts antigos?',
      message:
        (count === 1
          ? 'O prompt antigo, de antes da última mudança do plano e ainda não enviado, vai para _handoff/_descartados/: ' +
            'sai do envio, mas o arquivo continua no disco. '
          : `Os ${count} prompts antigos, de antes da última mudança do plano e ainda não enviados, vão para _handoff/_descartados/: ` +
            'saem do envio, mas os arquivos continuam no disco. ') + 'Prompt já enviado não sai.',
      confirmLabel: 'Descartar os antigos',
      cancelLabel: 'Manter',
      danger: true
    })
    if (ok) await move()
  }, [count, confirm, move])

  const beforeDraft = useCallback(async (): Promise<void> => {
    if (count === 0) return
    const ok = await confirm({
      title: 'Há prompts antigos',
      message:
        (count === 1
          ? 'Há 1 prompt antigo, de antes da última mudança do plano, ainda não enviado. '
          : `Há ${count} prompts antigos, de antes da última mudança do plano, ainda não enviados. `) +
        'Descartar os antigos antes de gravar o rascunho? Eles vão para _handoff/_descartados/. ' +
        '"Manter os antigos" grava o rascunho e deixa os antigos marcados como desatualizados.',
      confirmLabel: 'Descartar e gravar',
      cancelLabel: 'Manter os antigos'
    })
    if (ok) await move()
  }, [count, confirm, move])

  return { set, count, staleOutside: args.outside.some((h) => set.has(h.name)), fresh, discard, beforeDraft }
}
