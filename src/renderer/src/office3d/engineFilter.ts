/**
 * Filtro de projeto do Escritório 3D: o HUD escolhe, o motor aplica.
 *
 * - `choice`: a escolha do usuário, salva no localStorage (sobrevive ao F5 e a
 *   sair e voltar da aba).
 * - `current`: o filtro em vigor — a escolha, se o projeto está no escritório;
 *   senão Todos (null). Projeto que sumiu com o escritório populado apaga a
 *   escolha salva; com o feed ainda vazio (abrindo), ela fica guardada.
 *
 * `apply(id)` leva o filtro à cena (quem é de outro projeto sai pela porta);
 * `emit` manda ao HUD a lista (Todos + os projetos com ícone e agentes) quando
 * ela ou o filtro mudam; `onChange` avisa quem mais reage ao filtro (o quadro,
 * a TV).
 */
import type { ProjectLayout } from './layout'

export const FILTER_KEY = 'agent-code.office3d.projectFilter'

export interface FilterStorage {
  get(): string | null
  set(id: string | null): void
}

/** localStorage (sem ele — teste, modo restrito —, só memória). */
export function localFilterStorage(): FilterStorage {
  let mem: string | null = null
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      return null
    }
  }
  return {
    get() {
      try {
        return ls()?.getItem(FILTER_KEY) || mem
      } catch {
        return mem
      }
    },
    set(id) {
      mem = id
      try {
        if (id) ls()?.setItem(FILTER_KEY, id)
        else ls()?.removeItem(FILTER_KEY)
      } catch {
        // Armazenamento cheio ou bloqueado: fica só na memória.
      }
    }
  }
}

const sigOf = (projects: readonly ProjectLayout[], id: string | null): string =>
  `${id ?? ''}|${projects.map((p) => `${p.id}:${p.name}:${p.agents}:${p.icon ? p.icon.length : 0}:${p.color}`).join(',')}`

export class EngineFilter {
  private wanted: string | null
  private active: string | null = null
  private projects: readonly ProjectLayout[] = []
  private sig = ''
  private readonly listeners = new Set<(id: string | null) => void>()

  constructor(
    private readonly apply: (id: string | null) => void,
    private readonly emit: (projects: readonly ProjectLayout[], id: string | null) => void,
    private readonly storage: FilterStorage = localFilterStorage()
  ) {
    this.wanted = storage.get()
  }

  /** O filtro em vigor (null = Todos). */
  get current(): string | null {
    return this.active
  }

  /** A escolha salva (pode ainda não valer: o projeto não chegou no feed). */
  get choice(): string | null {
    return this.wanted
  }

  /** Avisa a cada troca do filtro em vigor; devolve o cancelamento. */
  onChange(fn: (id: string | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** A cada feed, com os projetos do escritório. */
  feed(projects: readonly ProjectLayout[]): void {
    this.projects = projects
    if (this.wanted && projects.length > 0 && !projects.some((p) => p.id === this.wanted)) this.choose(null)
    this.update()
  }

  /** Escolha do HUD (null = Todos). */
  set(id: string | null): void {
    this.choose(id)
    this.update()
  }

  private choose(id: string | null): void {
    this.wanted = id
    this.storage.set(id)
  }

  private update(): void {
    const next = this.wanted && this.projects.some((p) => p.id === this.wanted) ? this.wanted : null
    if (next !== this.active) {
      this.active = next
      this.apply(next)
      for (const fn of this.listeners) fn(next)
    }
    const sig = sigOf(this.projects, this.active)
    if (sig === this.sig) return
    this.sig = sig
    this.emit(this.projects, this.active)
  }
}
