/**
 * Estimativa de uma etapa do roteiro — minutos de trabalho do AGENTE
 * (src/shared/planningEstimate.ts) —, mostrada como "45 min", "1 h 30 min"
 * ou "—" quando a etapa não tem.
 *
 * Com `onSave`, clicar troca o texto por um campo pequeno no mesmo lugar:
 * Enter ou sair do campo grava, Esc cancela, vazio remove. Depois de Enter
 * ou Esc o foco volta ao botão da estimativa; ao sair do campo clicando em
 * outro lugar, o foco fica onde o usuário clicou. Quem valida
 * (inteiro de 1 a MAX_ESTIMATIVA_MIN) e avisa por toast é quem grava
 * (usePlanning.setEstimativa): o que não é inteiro chega lá como NaN.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PlanningRoteiroDto } from '@shared/ipc'
import { MAX_ESTIMATIVA_MIN, formatMinutos, isValidEstimativa, sumEstimativas } from '@shared/planningEstimate'

export const SEM_ESTIMATIVA = '—'
const HINT = 'minutos de trabalho do agente'

export function estimateText(minutos: number | null | undefined): string {
  return isValidEstimativa(minutos) ? formatMinutos(minutos) : SEM_ESTIMATIVA
}

/** O resumo do contador do roteiro: "Total: 3 h 20 min · 1 sem estimativa". */
export function estimateSummary(etapas: PlanningRoteiroDto['etapas']): string {
  const { total, semEstimativa } = sumEstimativas(etapas)
  if (semEstimativa === etapas.length) return 'Nenhuma etapa estimada'
  return `Total: ${formatMinutos(total)}${semEstimativa ? ` · ${semEstimativa} sem estimativa` : ''}`
}

/** Texto do campo → minutos: vazio = null (remover); o que não é inteiro = NaN. */
export function parseEstimativa(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

export interface StageEstimateProps {
  minutos?: number
  /** Nome da etapa, para o rótulo acessível. */
  titulo: string
  /** Sem ele, só mostra (trilho, canvas). */
  onSave?: (minutos: number | null) => void
}

export function StageEstimate({ minutos, titulo, onSave }: StageEstimateProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  // Enter/Esc já fecharam o campo: o blur que vem junto (ou depois) não grava de novo.
  const closed = useRef(false)
  // Fechou pelo teclado (Enter/Esc): o botão que volta no lugar do campo recebe o
  // foco, senão ele cairia no <body>. Pelo blur não: o foco já está onde o usuário quis.
  const refocus = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    button.current?.focus()
  }, [editing])
  const has = isValidEstimativa(minutos)
  const text = estimateText(minutos)
  const cls = `pl-est${has ? '' : ' empty'}`
  const title = has ? `Estimativa: ${text} (${HINT})` : `Sem estimativa (${HINT})`

  if (!onSave) {
    return (
      <span className={cls} title={title}>
        {text}
      </span>
    )
  }

  if (!editing) {
    return (
      <button
        ref={button}
        type="button"
        className={cls}
        title={`${title} — clique para editar`}
        aria-label={`Estimativa de ${titulo}: ${has ? text : 'nenhuma'}. Editar`}
        onClick={() => {
          closed.current = false
          setEditing(true)
        }}
      >
        {text}
      </button>
    )
  }

  const finish = (save: boolean, value: string, byKey: boolean): void => {
    if (closed.current) return
    closed.current = true
    refocus.current = byKey
    setEditing(false)
    if (!save) return
    const next = parseEstimativa(value)
    if (next !== (has ? minutos : null)) onSave(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true, e.currentTarget.value, true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // o Esc é do campo, não da tela
      finish(false, '', true)
    }
  }

  return (
    <input
      className="pl-est-input"
      type="text"
      inputMode="numeric"
      autoFocus
      maxLength={6}
      placeholder="min"
      defaultValue={has ? String(minutos) : ''}
      aria-label={`Estimativa de ${titulo}, em minutos`}
      title={`Minutos de trabalho do agente, de 1 a ${MAX_ESTIMATIVA_MIN}. Enter grava, Esc cancela, vazio remove`}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={(e) => finish(true, e.currentTarget.value, false)}
    />
  )
}
