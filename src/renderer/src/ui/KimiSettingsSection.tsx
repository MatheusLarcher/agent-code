import { useState } from 'react'
import type { AppConfig, KimiConnectionResult } from '@shared/ipc'
import { RevealButton } from './RevealButton'

/** Configurações → Kimi: interruptor, chave do Kimi Code, Testar conexão e as
 *  instruções da organização para os modelos não Claude. Mesmo molde da seção
 *  DeepSeek: edita o estado da tela, e quem grava é o Salvar do modal. O teste
 *  aplica região, janela e modelos do plano no estado (e liga o Kimi). */
export function KimiSettingsSection({
  cfg,
  setCfg,
  loaded,
  testConnection = (key) => window.api.kimiTestConnection(key)
}: {
  cfg: AppConfig
  setCfg: (update: (c: AppConfig) => AppConfig) => void
  loaded: boolean
  testConnection?: (apiKey: string) => Promise<KimiConnectionResult>
}): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<KimiConnectionResult | null>(null)

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const r = await testConnection(cfg.kimi.apiKey)
      setResult(r)
      if (r.ok) {
        setCfg((c) => ({
          ...c,
          kimi: {
            ...c.kimi,
            enabled: true,
            region: r.region ?? c.kimi.region,
            contextWindow: r.contextWindow ?? c.kimi.contextWindow,
            models: r.models ?? []
          }
        }))
      }
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-row">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={cfg.kimi.enabled}
            disabled={!loaded}
            onChange={(e) => setCfg((c) => ({ ...c, kimi: { ...c.kimi, enabled: e.target.checked } }))}
          />
          <span>
            <strong>Kimi (assinatura Kimi Code)</strong>
            <span className="settings-desc">
              Adiciona o Kimi K3.1 Pro ao seletor, usando a cota da sua assinatura do Kimi Code. Só o modelo da
              conversa e os subagentes rodam no Kimi; os auxiliares do app continuam na sua conta Claude.
            </span>
          </span>
        </label>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Chave do Kimi Code</span>
        <div className="settings-key-row">
          <input
            className="settings-input"
            type={showKey ? 'text' : 'password'}
            value={cfg.kimi.apiKey}
            placeholder="Cole a chave de kimi.ai/code/console → Chaves de API"
            autoComplete="off"
            spellCheck={false}
            disabled={!loaded}
            aria-label="Chave do Kimi Code"
            onChange={(e) => {
              const apiKey = e.target.value
              setResult(null)
              // Chave nova = plano ainda não testado: o seletor só mostra o Kimi depois do teste.
              setCfg((c) => ({ ...c, kimi: { ...c.kimi, apiKey, models: [] } }))
            }}
          />
          <RevealButton shown={showKey} onToggle={() => setShowKey((v) => !v)} />
        </div>
        <span className="settings-hint">
          <a href="https://www.kimi.ai/code/console" target="_blank" rel="noreferrer">
            Criar chave
          </a>{' '}
          no console do Kimi Code. A chave fica salva só no seu computador.
        </span>
      </label>

      <div className="settings-row">
        <button
          className="btn ghost"
          type="button"
          onClick={() => void runTest()}
          disabled={!loaded || testing || !cfg.kimi.apiKey.trim()}
        >
          {testing ? 'Testando…' : 'Testar conexão'}
        </button>
        {result && (
          <span className="settings-hint" role="status">
            {result.ok && <span className="settings-status-dot" aria-hidden="true" />}
            {result.message}
            {result.ok ? ' Clique em Salvar para usar.' : ''}
          </span>
        )}
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Instruções da organização para modelos não Claude</span>
        <textarea
          className="settings-input"
          rows={4}
          value={cfg.externalOrgInstructions}
          disabled={!loaded}
          aria-label="Instruções da organização para modelos não Claude"
          placeholder="Ex.: Responda sempre em português. Nunca invente dados."
          onChange={(e) => setCfg((c) => ({ ...c, externalOrgInstructions: e.target.value }))}
        />
        <span className="settings-hint">
          Valem para Kimi, GPT, Ollama e DeepSeek, com a mesma prioridade das instruções da organização no Claude.
          Em branco, nada é enviado.
        </span>
      </label>
    </section>
  )
}
