import type { CrewMember } from '../crew'
import { CrewRoleIcon } from './CrewIcons'

/**
 * Quem está trabalhando AGORA, na topbar — o mesmo sinal do elenco levado para
 * fora do painel. Sem ele, saber que um agente entrou em campo exigiria manter
 * a aba Agentes aberta, que é justamente o que o usuário não faz.
 *
 * Só aparece quando há alguém trabalhando: um chip permanente com "0" vira
 * mobília e para de ser lido.
 */
export function CrewChip({
  working,
  onOpen
}: {
  working: CrewMember[]
  onOpen: () => void
}): JSX.Element | null {
  if (working.length === 0) return null
  // Os avatares empilham; acima de 4 a pilha viraria um borrão, então o
  // excedente vira número no texto.
  const shown = working.slice(0, 4)
  return (
    <button
      type="button"
      className="crew-chip"
      onClick={onOpen}
      title={`Trabalhando agora: ${working.map((m) => m.name).join(', ')}`}
    >
      <span className="crew-stack" aria-hidden="true">
        {shown.map((m) => (
          <span
            key={m.id}
            className="crew-mini pulse"
            style={{ ['--role' as string]: `var(--crew-${m.role})` }}
          >
            <CrewRoleIcon role={m.role} size={11} />
          </span>
        ))}
      </span>
      <span className="crew-chip-n">{working.length} trabalhando</span>
    </button>
  )
}
