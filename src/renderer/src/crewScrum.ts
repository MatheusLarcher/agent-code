import type { CrewMember } from './crew'

/**
 * O cartão do Scrum Master no elenco, no molde do PO. Fica fora do `crew.ts`
 * (que já passou do teto de linhas). O SM não roda por turno: ele olha os
 * prazos dos envios de handoff e cobra quem atrasa (src/main/scrum), então o
 * cartão mostra só o papel — o que ele fez está no painel do escritório.
 */
export function scrumMember(): CrewMember {
  return {
    id: 'role:scrum',
    role: 'scrum',
    name: 'Scrum Master',
    kind: 'cobra os prazos',
    state: 'idle',
    line: [{ kind: 'text', text: 'acompanha os prazos dos handoffs e cobra quem atrasa' }],
    badge: { text: 'disponível', tone: 'plain' },
    group: 'observadores'
  }
}
