/**
 * A logo do projeto (a mesma da barra lateral do PC, via `/api/project-icon`) ou o
 * ícone de pasta quando o projeto não tem logo ou o PC é antigo e não serve a rota.
 */
import { useState } from 'react'
import { isSandboxProjectPath } from '@shared/projectColor'
import { client } from '../app/runtime'
import { basename } from '../core/format'
import { useStore } from '../core/store'
import { Icon } from './icons'

/** Nome do projeto como o PC mostra: as subpastas do sandbox são um projeto só, "Sandbox". */
export function projectLabel(cwd: string): string {
  return isSandboxProjectPath(cwd) ? 'Sandbox' : basename(cwd)
}

/** Pastas sem logo neste PC: não pede de novo a cada montagem (some ao reabrir o app). */
const missing = new Set<string>()

export function ProjectLogo({ cwd, size }: { cwd: string; size: number }): JSX.Element {
  const base = useStore(client.store, (s) => s.base)
  const k = `${base}|${cwd}`
  // A falha vale para ESTA pasta: o cabeçalho reaproveita o componente ao trocar de conversa.
  const [failedKey, setFailedKey] = useState<string | null>(null)
  if (isSandboxProjectPath(cwd)) return <Icon name="sandbox" size={size} className="proj-logo proj-logo-glyph" />
  if (!cwd || failedKey === k || missing.has(k)) return <Icon name="folder" size={size} className="proj-logo proj-logo-glyph" />
  return (
    <img
      key={k}
      className="proj-logo"
      alt=""
      width={size}
      height={size}
      src={client.url(`/api/project-icon?cwd=${encodeURIComponent(cwd)}`)}
      onError={() => {
        missing.add(k)
        setFailedKey(k)
      }}
    />
  )
}
