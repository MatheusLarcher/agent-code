/**
 * Os ícones dos projetos (o `projectIcons` do App, por pasta) para quem mostra
 * o nome do projeto num chat: o App põe o mapa em volta da área principal e
 * cada cabeçalho põe o `ProjectNameIcon` ao lado do nome. Sem provider (testes,
 * quem monta sem o App), o mapa é vazio e sai a pasta, como na barra lateral.
 */
import { createContext, useContext } from 'react'
import { ProjectGlyph } from './Icons'

export const ProjectIconsContext = createContext<Readonly<Record<string, string | null>>>({})

/** O ícone do projeto da pasta `cwd` (a imagem dele, senão a pasta). */
export function ProjectNameIcon({ cwd, size = 13 }: { cwd: string; size?: number }): JSX.Element {
  const icons = useContext(ProjectIconsContext)
  return (
    <span className="project-name-icon" aria-hidden="true">
      <ProjectGlyph icon={icons[cwd] ?? null} size={size} />
    </span>
  )
}
