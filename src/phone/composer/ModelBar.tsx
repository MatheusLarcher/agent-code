/**
 * Modelo, esforço e o modo Rápido da conversa aberta — os mesmos seletores do
 * composer do PC, com as mesmas regras: o PC manda o que vale (no chat do Agent
 * Manager, a config dele e a lista própria em `conv.models`) e o "Auto · X". Com a
 * conversa ocupada continuam livres: a troca entra na próxima rodada, como no PC
 * (o toast avisa).
 *
 * Com o dropdown nativo aberto, o retrato de 4 s não pode mexer no <select> (no
 * app antigo o rebuild fechava a escolha no meio): enquanto ele tem foco, a barra
 * mostra a última foto. E o blur() logo depois da escolha: o Android deixa o
 * <select> focado quando o diálogo nativo fecha, e a barra nunca mais acompanharia o PC.
 */
import { useRef, useState } from 'react'
import { client, toast } from '../app/runtime'
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

  const list = conv?.models?.length ? conv.models : models
  if (!conv || !list.length) return null
  const live: Snapshot = { conv, models: list, levels: modelEffort[conv.model ?? ''] ?? [], labels }
  const snap = focused && last.current ? last.current : live
  last.current = snap
  const c = snap.conv
  const model = c.model || snap.models[0]?.id || ''
  // "Auto · Alto": o nível que o decisor escolheu no último turno, com o esforço em Automático.
  const levelLabel = (l: string): string =>
    l === c.effort && c.runningEffort ? `${snap.labels[l] || l} · ${snap.labels[c.runningEffort] || c.runningEffort}` : snap.labels[l] || l

  const done = (e: { currentTarget: HTMLSelectElement }): void => {
    e.currentTarget.blur()
    setFocused(false)
  }

  /** Com o agente rodando, a troca fica guardada no PC e entra na próxima mensagem da fila. */
  const change = (patch: { model?: string; effort?: string }): void => {
    const busy = !!client.current()?.busy
    client.setModel(patch)
    if (busy) toast(`${patch.model ? 'Modelo' : 'Esforço'} trocado — entra na próxima rodada`, 'sucesso')
  }

  return (
    <div className="model-bar">
      <select
        className="model-select"
        aria-label="Modelo"
        value={model}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const value = e.currentTarget.value
          done(e)
          change({ model: value })
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const value = e.currentTarget.value
            done(e)
            change({ effort: value })
          }}
        >
          {snap.levels.map((l) => (
            <option key={l} value={l}>{levelLabel(l)}</option>
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
