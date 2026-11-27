import { useEffect, useState } from 'react'
import { useUI } from './UiProvider'

type Conversa = { id: string; titulo: string; pasta: string | null; atualizadaEm: string | null; pedidos: number; jaExiste: boolean }

/**
 * Importar conversas do Agent Code original (Configurações › Dados, só na Homol). O app de
 * origem é lido numa cópia — não é mexido e pode ficar aberto. As escolhidas entram ao lado
 * das que já existem; as que já estão aqui aparecem marcadas como "já importada".
 */
export function ImportarConversasField(): JSX.Element {
  const { notify } = useUI()
  const [conversas, setConversas] = useState<Conversa[] | null>(null)
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'listar' | 'importar' | null>(null)
  const [error, setError] = useState('')
  const [auto, setAuto] = useState<{ disponivel: boolean; ligado: boolean; ultimaEm: string | null; ultimoResumo: string | null } | null>(null)

  useEffect(() => {
    void window.api.importarAutoStatus?.().then(setAuto).catch(() => setAuto(null))
  }, [])

  const alternarAuto = async (ligado: boolean): Promise<void> => {
    const r = await window.api.importarAutoSet(ligado).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (!r.ok) return setError(r.error)
    setAuto(await window.api.importarAutoStatus())
    notify('sucesso', ligado ? 'Importação automática ligada: as conversas novas chegam sozinhas.' : 'Importação automática desligada.')
  }

  const listar = async (): Promise<void> => {
    setBusy('listar')
    setError('')
    const r = await window.api.importarPrincipalListar().catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    setBusy(null)
    if (!r.ok) return setError(r.error)
    setConversas(r.conversas)
    setMarcadas(new Set(r.conversas.filter((c) => !c.jaExiste).map((c) => c.id)))
  }

  const importar = async (): Promise<void> => {
    setBusy('importar')
    setError('')
    const r = await window.api.importarPrincipalImportar([...marcadas]).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    setBusy(null)
    if (!r.ok) return setError(r.error)
    if (r.falhas.length) setError(`Não deu para importar: ${r.falhas.join('; ')}`)
    notify('sucesso', `${r.importadas} conversa(s) importada(s)${r.puladas ? `, ${r.puladas} já estavam aqui` : ''}.`)
    setConversas(null)
    setMarcadas(new Set())
    // A lista de conversas da barra lateral é lida ao abrir: recarrega para as novas aparecerem.
    if (r.importadas > 0) window.dispatchEvent(new Event('agent-code-request-reload'))
  }

  const alternar = (id: string): void =>
    setMarcadas((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="settings-field" data-testid="importar-conversas">
      <span className="settings-field-label">Importar conversas do Agent Code</span>
      <span className="settings-hint">
        Traz para cá conversas do Agent Code instalado neste computador, para continuar de onde parou. O Agent Code
        não é mexido e pode ficar aberto. Nada daqui é apagado ou substituído.
      </span>

      {auto?.disponivel && (
        <label className="settings-row importar-auto">
          <input type="checkbox" checked={auto.ligado} onChange={(e) => void alternarAuto(e.target.checked)} />
          <span>
            Trazer sozinho, a cada 30 minutos, as conversas novas e as memórias que elas usaram
            {auto.ultimaEm && (
              <span className="settings-hint">
                {' '}
                · última vez {new Date(auto.ultimaEm).toLocaleString('pt-BR')}: {auto.ultimoResumo}
              </span>
            )}
          </span>
        </label>
      )}

      {!conversas && (
        <div className="settings-row">
          <button className="btn" type="button" disabled={!!busy} onClick={() => void listar()}>
            {busy === 'listar' ? 'Lendo as conversas… (pode levar até 1 minuto)' : 'Ver conversas do Agent Code'}
          </button>
        </div>
      )}

      {conversas && (
        <>
          {conversas.length === 0 ? (
            <span className="settings-hint">O Agent Code não tem conversas para importar.</span>
          ) : (
            <ul className="importar-lista" aria-label="Conversas do Agent Code">
              {conversas.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" disabled={c.jaExiste || !!busy} checked={c.jaExiste || marcadas.has(c.id)} onChange={() => alternar(c.id)} />
                    <span className="importar-titulo">{c.titulo}</span>
                    <span className="importar-info">
                      {c.jaExiste
                        ? 'já importada'
                        : `${c.pedidos} pedido(s)${c.atualizadaEm ? ` · ${new Date(c.atualizadaEm).toLocaleDateString('pt-BR')}` : ''}`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-row">
            <button className="btn primary" type="button" disabled={!!busy || marcadas.size === 0} onClick={() => void importar()}>
              {busy === 'importar' ? 'Importando…' : `Importar ${marcadas.size} conversa(s)`}
            </button>
            <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setConversas(null)}>
              Cancelar
            </button>
          </div>
        </>
      )}

      {error && (
        <span className="settings-hint" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
