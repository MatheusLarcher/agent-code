/**
 * Os ícones das ações do agente (traço, `currentColor`): um por tipo de pílula
 * da linha de passos (stepPills.ts — busca, leitura, edição, comando, pesquisa,
 * navegador, subagente) e os do grupo (achar, mexer, ferramenta). Puro SVG,
 * sem dependência: vale para o PC e para o celular (@renderer).
 */
import type { ReactNode } from 'react'
import type { PillKind } from './stepPills'

export type StepGlyph = PillKind | 'find' | 'code' | 'tool'

const PATHS: Record<StepGlyph, ReactNode> = {
  // Lupa.
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  // Página com dobra e linhas (o arquivo lido).
  read: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  // Lápis.
  edit: (
    <>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
      <path d="m14.5 5.5 3 3" />
    </>
  ),
  // Terminal.
  bash: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
    </>
  ),
  // Globo.
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  // Janela com o cursor (o navegador embutido).
  browser: (
    <>
      <rect x="3" y="4" width="18" height="15" rx="2.5" />
      <path d="M3 8.5h18M6.5 6.3h.01M9 6.3h.01" />
      <path d="m12 11 5 2-2.1.9-.9 2.1z" />
    </>
  ),
  // Robozinho (o subagente).
  agent: (
    <>
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01M2.5 13v2.5M21.5 13v2.5" />
      <circle cx="12" cy="4" r="1" />
    </>
  ),
  // Chave inglesa.
  other: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  // Grupo de achar/ler: lupa com brilho.
  find: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m19.5 19.5-4.5-4.5M8 8.6a3 3 0 0 1 2.4-1.2" />
    </>
  ),
  // Grupo que mexe: chaves de código.
  code: <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />,
  // Grupo misto: faísca.
  tool: <path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2z" />
}

export function StepKindIcon({ kind, size = 13, className }: { kind: StepGlyph; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  )
}

/** O texto do tooltip de uma pílula: "4 buscas", "1 subagente". */
export const pillTip = (p: { n: number; label: string }): string => `${p.n} ${p.label}`
