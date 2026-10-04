/**
 * O ícone de um destino na Central — o MESMO da barra lateral: o do projeto
 * (data URL), a pasta quando ele não tem, o balde do sandbox; conversa nova, o +.
 * `round` = o do trilho (18 px, redondo); senão o dos botões (16 px).
 */
import { IconPlus, IconSandbox, ProjectGlyph } from '../components/Icons'
import { whoOf, type CentralGlyphKind } from './centralView'
import type { CentralLabel } from './centralRecents'

export function CentralGlyph({ icon, kind, round = false }: { icon: string | null; kind: CentralGlyphKind; round?: boolean }): JSX.Element {
  const glyph =
    kind === 'sandbox' ? <IconSandbox size={11} /> : kind === 'new' ? <IconPlus size={11} /> : <ProjectGlyph icon={icon} size={11} />
  return (
    <span className={`central-pi${round ? ' round' : ''}${kind === 'project' && icon ? ' img' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  )
}

/** "projeto · conversa" com o ícone do projeto antes (destino desconhecido: só o texto). */
export function CentralWho({ label, suffix = '' }: { label: CentralLabel; suffix?: string }): JSX.Element {
  return (
    <>
      {label.project && <CentralGlyph icon={label.icon} kind={label.sandbox ? 'sandbox' : 'project'} />}
      {whoOf(label)}
      {suffix}
    </>
  )
}
