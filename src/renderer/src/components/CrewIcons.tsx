import type { SVGProps } from 'react'
import type { CrewRole } from '../crew'

/**
 * Um ícone de traço por papel do elenco, no mesmo molde do `Icons.tsx`
 * (stroke = currentColor, viewBox 24). Ficam separados porque são a identidade
 * visual do time — a cor do papel entra por `currentColor`, então o mesmo
 * desenho serve no cartão, no chip da topbar e na linha do tempo.
 */

type IconProps = { size?: number } & SVGProps<SVGSVGElement>

function Svg({ size = 17, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Agente principal — a mesma faísca da marca. */
export const IconRolePrincipal = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </Svg>
)
/** Executor — a chave de quem põe a mão. */
export const IconRoleExecutor = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 1 5 5L16 15l-7 7-4-4 7-7z" />
    <path d="m5 19 1.5-1.5" />
  </Svg>
)
/** Crítico — escudo com o visto. */
export const IconRoleCritico = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)
/** Navegador de código — a lupa. */
export const IconRoleNavegador = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
)
/** Memória. */
export const IconRoleMemoria = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 4a5 5 0 0 0-5 5v1a4 4 0 0 0 0 8h1a4 4 0 0 0 8 0h1a4 4 0 0 0 0-8V9a5 5 0 0 0-5-5z" />
  </Svg>
)
/** PO — o cartão do quadro, marcado. */
export const IconRolePo = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="m8.5 12.5 2.2 2.2 4.8-4.8" />
  </Svg>
)
/** Vigia — a interrogação de quem questiona a premissa. */
export const IconRoleVigia = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3" />
    <path d="M12 17h.01" />
  </Svg>
)
/** Subagente de tipo que não é do nosso cadastro. */
export const IconRoleSubagente = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <circle cx="12" cy="12" r="8.5" />
  </Svg>
)

const BY_ROLE: Record<CrewRole, (p: IconProps) => JSX.Element> = {
  principal: IconRolePrincipal,
  executor: IconRoleExecutor,
  critico: IconRoleCritico,
  'navegador-de-codigo': IconRoleNavegador,
  memoria: IconRoleMemoria,
  po: IconRolePo,
  vigia: IconRoleVigia,
  subagente: IconRoleSubagente
}

export function CrewRoleIcon({ role, size }: { role: CrewRole; size?: number }): JSX.Element {
  const Icon = BY_ROLE[role] ?? IconRoleSubagente
  return <Icon size={size} />
}
