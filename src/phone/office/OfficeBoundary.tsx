/**
 * Uma falha no Escritório do celular (o 3D, o monitor do agente, a TV, o
 * quadro, a estante) não derruba o app: no lugar dele, o aviso com a mensagem
 * e "Voltar", que remonta o escritório do zero (sem a tela que falhou). A
 * mesma ideia do `OfficeErrorBoundary` do PC (components/MainTabs.tsx).
 */
import { Component, Fragment, type ReactNode } from 'react'

interface State {
  error: Error | null
  /** Sobe a cada "Voltar": a chave nova remonta o escritório. */
  gen: number
}

export class OfficeBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, gen: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  private back = (): void => this.setState((s) => ({ error: null, gen: s.gen + 1 }))

  render(): ReactNode {
    const { error, gen } = this.state
    if (!error) return <Fragment key={gen}>{this.props.children}</Fragment>
    return (
      <div className="office-error" role="alert">
        <p className="office-error-msg">O Escritório falhou: {error.message || String(error)}</p>
        <button type="button" className="btn primary" onClick={this.back}>
          Voltar
        </button>
      </div>
    )
  }
}
