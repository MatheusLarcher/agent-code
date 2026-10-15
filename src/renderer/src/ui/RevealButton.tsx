import { IconEye, IconEyeOff } from '../components/Icons'

/** Eye toggle for secret fields — replaces the old emoji buttons. */
export function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      className="btn ghost settings-reveal"
      type="button"
      onClick={onToggle}
      title={shown ? 'Ocultar' : 'Mostrar'}
      aria-label={shown ? 'Ocultar chave' : 'Mostrar chave'}
    >
      {shown ? <IconEyeOff size={15} /> : <IconEye size={15} />}
    </button>
  )
}
