/**
 * Modelo, esforço e o modo Rápido da conversa aberta — os mesmos seletores do
 * composer do PC. Travados com a conversa ocupada.
 *
 * Com o dropdown nativo aberto, o retrato de 4 s não pode mexer no <select> (no
 * app antigo o rebuild fechava a escolha no meio): enquanto ele tem foco, a barra
 * mostra a última foto. E o blur() logo depois da escolha: o Android deixa o
 * <select> focado quando o diálogo nativo fecha, e a barra nunca mais acompanharia o PC.
 */
import { useRef, useState } from 'react'
import { client } from '../app/runtime'
import { useStore } from '../core/store'
import type { ConvSummary, ModelOption } from '../core/types'

interface Snapshot {
  conv: ConvSummary
  models: ModelOption[]
  levels: string[]
  labels: Record<string, string>
}

export function ModelBar(): JSX.Element | null {
  const conv = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId) ?? null)
  const models = useStore(client.store, (s) => s.models)
  const modelEffort = useStore(client.store, (s) => s.modelEffort)
  const labels = useStore(client.store, (s) => s.effortLabels)
  const [focused, setFocused] = useState(false)
  const last = useRef<Snapshot | null>(null)

  if (!conv || !models.length) return null
  const live: Snapshot = { conv, models, levels: modelEffort[conv.model ?? ''] ?? [], labels }
  const snap = focused && last.current ? last.current : live
  last.current = snap
  const c = snap.conv
  const busy = !!conv.busy
  const model = c.model || snap.models[0]?.id || ''

  const done = (e: { currentTarget: HTMLSelectElement }): void => {
    e.currentTarget.blur()
    setFocused(false)
  }


  return (
    <div className="model-bar">
      <select
        className="model-select"
        aria-label="Modelo"
        value={model}
        disabled={busy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          done(e)
          client.setModel({ model: e.currentTarget.value })
        }}
      >
        {snap.models.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
        {!snap.models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
      </select>
      {snap.levels.length > 0 && (
        <select
          className="model-select effort-select"
          aria-label="Esforço"
          value={c.effort || 'high'}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            done(e)
            client.setModel({ effort: e.currentTarget.value })
          }}
        >
          {snap.levels.map((l) => (
            <option key={l} value={l}>{snap.labels[l] || l}</option>
          ))}
        </select>
      )}
      {conv.fastModeAvailable && (
        <button type="button" className={`mode-chip${conv.fastMode ? ' on' : ''}`} title="Modo rápido" onClick={() => client.setMode('fast', !conv.fastMode)}>
          ↯ Rápido
        </button>
      )}
    </div>
  )
}
