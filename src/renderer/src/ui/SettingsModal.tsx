import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CONFIG, OPENAI_VOICES, type AppConfig, type CacheInfo } from '@shared/ipc'
import { useUI } from './UiProvider'

interface Props {
  onClose: () => void
  /** When 'openai', highlight + scroll to the OpenAI key (a voice feature needs it). */
  focus?: 'openai' | null
}

/**
 * App settings. Currently the optional Google Stitch integration: enable it and
 * paste an API key (Stitch → Settings → API Keys) to give the agent the Stitch
 * MCP tools for generating UI mockups. Changes apply to sessions started after
 * saving (reconnect a conversation to pick them up).
 */
export function SettingsModal({ onClose, focus }: Props): JSX.Element {
  const { notify } = useUI()
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT_CONFIG)
  const [showKey, setShowKey] = useState(false)
  const [showOpenAiKey, setShowOpenAiKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const openAiRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.api.getConfig().then((c) => {
      setCfg(c)
      setLoaded(true)
    })
    void window.api.getCacheInfo().then(setCache)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // When opened to nudge the OpenAI key, scroll to and focus that field.
  useEffect(() => {
    if (focus === 'openai' && loaded) {
      openAiRef.current?.scrollIntoView({ block: 'center' })
      openAiRef.current?.focus()
    }
  }, [focus, loaded])

  const save = async (): Promise<void> => {
    const stitch = { ...cfg.stitch, apiKey: cfg.stitch.apiKey.trim() }
    const openai = { ...cfg.openai, apiKey: cfg.openai.apiKey.trim() }
    // Enabling without a key is pointless — warn but still save the preference.
    if (stitch.enabled && !stitch.apiKey) {
      notify('aviso', 'Informe a API key do Stitch para habilitar a integração.')
    }
    // Save only the keys we edit here so we never clobber other settings (e.g. "Permitir tudo").
    await window.api.setConfig({ stitch, openai })
    notify('sucesso', 'Configurações salvas. Reconecte a conversa para aplicar.')
    onClose()
  }

  const changeCacheDir = async (): Promise<void> => {
    const next = await window.api.chooseCacheDir()
    if (!next) return
    setCache(next)
    // Re-read config from the newly selected folder so the screen reflects it.
    void window.api.getConfig().then(setCfg)
    notify(
      'sucesso',
      `Pasta de dados movida para: ${next.dir}. Seus dados (banco + memórias) foram transferidos.`
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">⚙️ Configurações</h3>

        <section className="settings-section">
          <label className="settings-field">
            <span className="settings-field-label">📁 Pasta de dados (cache)</span>
            <div className="settings-key-row">
              <input
                className="settings-input"
                type="text"
                value={cache?.dir ?? 'carregando…'}
                readOnly
                spellCheck={false}
                title={cache?.dir ?? ''}
              />
              <button className="btn ghost" type="button" onClick={changeCacheDir} disabled={!cache}>
                Trocar…
              </button>
            </div>
            <span className="settings-hint">
              Onde ficam o banco SQLite (configurações, token do Android, conversas) e as memórias
              (.md). É por usuário, não por projeto. Uma pasta <code>agent-code</code> é criada dentro
              do local selecionado. Se a pasta nova estiver vazia, seus dados atuais são movidos para
              lá; se já tiver dados do Agent Code, eles são carregados. Pode ficar no OneDrive/Google
              Drive — o app não trava os arquivos, então o backup funciona com o app aberto.
            </span>
          </label>
        </section>

        <section className="settings-section">
          <div className="settings-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={cfg.stitch.enabled}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, stitch: { ...c.stitch, enabled: e.target.checked } }))}
              />
              <span>
                <strong>✨ Google Stitch</strong>
                <span className="settings-desc">
                  Gera mockups de UI por IA. Quando ativo, o agente pode criar um design, exibi-lo no
                  preview e implementá-lo no projeto após sua aprovação.
                </span>
              </span>
            </label>
          </div>

          <label className="settings-field">
            <span className="settings-field-label">API key do Stitch</span>
            <div className="settings-key-row">
              <input
                className="settings-input"
                type={showKey ? 'text' : 'password'}
                value={cfg.stitch.apiKey}
                placeholder="Cole a key de Stitch → Settings → API Keys"
                autoComplete="off"
                spellCheck={false}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, stitch: { ...c.stitch, apiKey: e.target.value } }))}
              />
              <button className="btn ghost" type="button" onClick={() => setShowKey((v) => !v)} title="Mostrar/ocultar">
                {showKey ? '🙈' : '👁️'}
              </button>
            </div>
            <span className="settings-hint">
              Gere em stitch.withgoogle.com → ícone de perfil → Stitch Settings → API Keys → Create Key.
              A chave fica salva só no seu computador.
            </span>
          </label>
        </section>

        <section className={`settings-section ${focus === 'openai' ? 'settings-highlight' : ''}`}>
          <label className="settings-field">
            <span className="settings-field-label">🎙️ OpenAI (voz no chat)</span>
            {focus === 'openai' && (
              <span className="settings-warn">
                Adicione sua API key da OpenAI para usar o microfone e a leitura em voz alta.
              </span>
            )}
            <div className="settings-key-row">
              <input
                ref={openAiRef}
                className="settings-input"
                type={showOpenAiKey ? 'text' : 'password'}
                value={cfg.openai.apiKey}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, openai: { ...c.openai, apiKey: e.target.value } }))}
              />
              <button
                className="btn ghost"
                type="button"
                onClick={() => setShowOpenAiKey((v) => !v)}
                title="Mostrar/ocultar"
              >
                {showOpenAiKey ? '🙈' : '👁️'}
              </button>
            </div>
            <span className="settings-hint">
              Gere em platform.openai.com → API keys. Habilita falar para escrever (transcrição,
              gpt-4o-mini-transcribe) e ouvir as respostas (gpt-4o-mini-tts). A chave fica salva só no
              seu computador (no banco da pasta de dados).
            </span>
          </label>

          <div className="settings-key-row settings-voice-row">
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Voz da leitura</span>
              <select
                className="settings-input"
                value={cfg.openai.voice}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, openai: { ...c.openai, voice: e.target.value } }))}
              >
                {OPENAI_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Velocidade</span>
              <select
                className="settings-input"
                value={String(cfg.openai.speed)}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, openai: { ...c.openai, speed: Number(e.target.value) } }))}
              >
                <option value="0.8">Devagar</option>
                <option value="1">Normal</option>
                <option value="1.25">Rápida</option>
                <option value="1.5">Bem rápida</option>
              </select>
            </label>
          </div>
        </section>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save} disabled={!loaded}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
