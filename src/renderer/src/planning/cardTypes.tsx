/**
 * Metadados visuais dos tipos de card e do status de etapa: rótulo, ícone e a
 * ordem em que aparecem no editor. A COR de cada tipo mora no planning.css
 * (--pl-<tipo>), para o canvas, o minimapa e o editor usarem a mesma.
 */
import type { PlanningCardType, PlanningStageStatus } from '@shared/ipc'

export const CARD_TYPE_ORDER: PlanningCardType[] = ['etapa', 'requisito', 'decisao', 'sugestao', 'ambiguidade', 'nota']

export const CARD_TYPE_LABEL: Record<PlanningCardType, string> = {
  etapa: 'Etapa',
  requisito: 'Requisito',
  decisao: 'Decisão',
  sugestao: 'Sugestão',
  ambiguidade: 'Ambiguidade',
  nota: 'Nota'
}

export const STAGE_STATUS_LABEL: Record<PlanningStageStatus, string> = {
  pendente: 'Pendente',
  em_andamento: 'Em andamento',
  concluida: 'Concluída'
}

export const AMBIGUITY_STATUSES = ['aberta', 'resolvida'] as const

/** Cor do tipo como var CSS (definida no .planning) — serve em `style`. */
export function typeColorVar(tipo: PlanningCardType): string {
  return `var(--pl-${tipo})`
}

const PATHS: Record<PlanningCardType, JSX.Element> = {
  etapa: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  requisito: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2 2.3-2.2M4 18l1.2 1.2 2.3-2.2" />
    </>
  ),
  decisao: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.3 12.4l2.6 2.6 4.8-5.2" />
    </>
  ),
  sugestao: (
    <>
      <path d="M9.5 18h5M10.5 21h3" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" />
    </>
  ),
  ambiguidade: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2.9-1.2 1.7v.4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  nota: (
    <>
      <path d="M5 4h14v10l-6 6H5z" />
      <path d="M13 20v-6h6" />
      <path d="M8.5 9h7" />
    </>
  )
}

export function TypeIcon({ tipo, size = 14 }: { tipo: PlanningCardType; size?: number }): JSX.Element {
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
      {PATHS[tipo] ?? PATHS.nota}
    </svg>
  )
}

/** Marca de status da etapa: anel vazio, anel com meio preenchido, check. */
export function StageStatusIcon({ status, size = 16 }: { status: PlanningStageStatus; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {status === 'concluida' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : status === 'em_andamento' ? (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 3.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />
        </>
      ) : (
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2" />
      )}
    </svg>
  )
}
