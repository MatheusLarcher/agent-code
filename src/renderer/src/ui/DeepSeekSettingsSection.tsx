import { useState } from 'react'
import type { AppConfig } from '@shared/ipc'
import { RevealButton } from './RevealButton'

/** Configurações → DeepSeek: interruptor + chave. Mesmo molde da seção Ollama:
 *  edita o estado da tela, e quem grava é o Salvar do modal. */
export function DeepSeekSettingsSection({
  cfg,
  setCfg,
  loaded
}: {
  cfg: AppConfig
  setCfg: (update: (c: AppConfig) => AppConfig) => void
  loaded: boolean
}): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  return (
    <section className="settings-section">
      <div className="settings-row">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={cfg.deepseek.enabled}
            disabled={!loaded}
            onChange={(e) => setCfg((c) => ({ ...c, deepseek: { ...c.deepseek, enabled: e.target.checked } }))}
          />
          <span>
            <strong>DeepSeek</strong>
            <span className="settings-desc">
              Adiciona o DeepSeek V4.1 Flash ao seletor. Roda pela API compatível com a Anthropic da DeepSeek,
              cobrada por token na sua conta DeepSeek. Os auxiliares do app continuam usando sua conta Claude.
            </span>
          </span>
        </label>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">API key da DeepSeek</span>
        <div className="settings-key-row">
          <input
            className="settings-input"
            type={showKey ? 'text' : 'password'}
            value={cfg.deepseek.apiKey}
            placeholder="Cole a key de platform.deepseek.com → API keys"
            autoComplete="off"
            spellCheck={false}
            disabled={!loaded}
            aria-label="API key da DeepSeek"
            onChange={(e) => setCfg((c) => ({ ...c, deepseek: { ...c.deepseek, apiKey: e.target.value } }))}
          />
          <RevealButton shown={showKey} onToggle={() => setShowKey((v) => !v)} />
        </div>
        <span className="settings-hint">
          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
            Gerar chave
          </a>{' '}
          em platform.deepseek.com. Depois de salvar, escolha o DeepSeek no seletor acima do chat. A chave fica
          salva só no seu computador (no banco da pasta de dados).
        </span>
      </label>
    </section>
  )
}
