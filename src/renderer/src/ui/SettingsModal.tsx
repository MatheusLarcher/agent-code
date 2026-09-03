import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CONFIG,
  LOCAL_SPEECH_MODELS,
  OPENAI_VOICES,
  type AppConfig,
  type CacheInfo,
  type CodexStatus
} from '@shared/ipc'
import { useUI } from './UiProvider'
import { PostgresSettingsSection } from './PostgresSettingsSection'
import {
  IconDatabase,
  IconEye,
  IconEyeOff,
  IconKey,
  IconMic,
  IconMonitor,
  IconSettings,
  IconSliders,
  IconUnlock
} from '../components/Icons'

interface Props {
  onClose: () => void
  /** When 'openai', open the Voice tab, highlight + focus the OpenAI key. */
  focus?: 'openai' | null
  /** Global "allow all tools" switch — applies live (not gated by Save). */
  skipPerms: boolean
  onToggleSkipPerms: (on: boolean) => void
  windowsControlEnabled: boolean
  onToggleWindowsControl: (on: boolean) => void
}

type Tab = 'geral' | 'modelos' | 'voz' | 'dados'

const TABS: { id: Tab; label: string; hint: string; icon: JSX.Element }[] = [
  { id: 'geral', label: 'Geral', hint: 'Permissões do agente', icon: <IconSliders size={16} /> },
  { id: 'modelos', label: 'Modelos e contas', hint: 'Claude, ChatGPT, Ollama', icon: <IconKey size={16} /> },
  { id: 'voz', label: 'Voz', hint: 'Ditado e leitura', icon: <IconMic size={16} /> },
  { id: 'dados', label: 'Dados', hint: 'Pasta e PostgreSQL', icon: <IconDatabase size={16} /> }
]

/** Eye toggle for secret fields — replaces the old emoji buttons. */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      className="btn ghost settings-reveal"
      type="button"
      onClick={onToggle}
      title={shown ? 'Ocultar' : 'Mostrar'}
      aria-label={shown ? 'Ocultar chave' : 'Mostrar chave'}
    >
      {shown ? <IconEyeOff size={15} /> : <IconEye size={15} />}
    </button>
  )
}

/**
 * App settings, organized in tabs: Geral (live permission switches), Modelos e
 * contas (Claude / ChatGPT / Ollama), Voz (OpenAI key, voice, transcription) and
 * Dados (cache folder, PostgreSQL). Only the Voz/Ollama fields go through Save;
 * the switches and account buttons apply immediately.
 */
export function SettingsModal({
  onClose,
  focus,
  skipPerms,
  onToggleSkipPerms,
  windowsControlEnabled,
  onToggleWindowsControl
}: Props): JSX.Element {
  const { notify } = useUI()
  const [tab, setTab] = useState<Tab>(focus === 'openai' ? 'voz' : 'geral')
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT_CONFIG)
  const [showOpenAiKey, setShowOpenAiKey] = useState(false)
  const [showOllamaKey, setShowOllamaKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [codex, setCodex] = useState<CodexStatus>({ connected: false })
  const [codexBusy, setCodexBusy] = useState(false)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const openAiRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.api.getConfig()
      .then((c) => setCfg(c))
      .catch(() => undefined)
      .finally(() => setLoaded(true))
    void window.api.getCacheInfo().then(setCache)
    void window.api.codexStatus().then(setCodex)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // When opened to nudge the OpenAI key, focus that field (its tab is already active).
  useEffect(() => {
    if (focus === 'openai' && loaded && tab === 'voz') {
      openAiRef.current?.scrollIntoView({ block: 'center' })
      openAiRef.current?.focus()
    }
  }, [focus, loaded, tab])

  const save = async (): Promise<void> => {
    const openai = { ...cfg.openai, apiKey: cfg.openai.apiKey.trim() }
    const ollama = { ...cfg.ollama, apiKey: cfg.ollama.apiKey.trim() }
    // Enabling without a key is pointless — warn but still save the preference.
    if (ollama.enabled && !ollama.apiKey) {
      notify('aviso', 'Informe a API key do Ollama para habilitar a integração.')
    }
    // Save only the keys we edit here so we never clobber other settings (e.g. "Permitir tudo").
    await window.api.setConfig({
      openai,
      ollama,
      transcribeEngine: cfg.transcribeEngine,
      localSpeech: cfg.localSpeech
    })
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
    window.dispatchEvent(new Event('agent-code-request-reload'))
  }

  const connectCodex = async (): Promise<void> => {
    setCodexBusy(true)
    try {
      const result = await window.api.codexLogin()
      if (result.ok) {
        setCodex(await window.api.codexStatus())
        notify('sucesso', 'Conectado com o ChatGPT.')
      } else {
        notify('erro', 'Não foi possível conectar com o ChatGPT. Tente novamente.')
      }
    } finally {
      setCodexBusy(false)
    }
  }

  const disconnectCodex = async (): Promise<void> => {
    await window.api.codexLogout()
    setCodex({ connected: false })
    notify('aviso', 'Desconectado do ChatGPT.')
  }

  // Desconecta de verdade (logout + caches de auth), CONFIRMA pelo CLI que a
  // máquina está deslogada e só então abre o login — assim o navegador nunca
  // reaproveita a conta anterior em silêncio.
  const switchClaudeAccount = async (): Promise<void> => {
    setClaudeBusy(true)
    try {
      const status = await window.api.authLogout()
      if (status.loggedIn) {
        notify('erro', 'Não foi possível desconectar a conta atual do Claude. Feche o app e tente de novo.')
        return
      }
      notify('aviso', 'Conta desconectada. Abrindo o login para você escolher a nova conta…')
      const { ok } = await window.api.authLogin()
      notify(
        ok ? 'sucesso' : 'erro',
        ok
          ? 'Login concluído com a nova conta do Claude.'
          : 'Login não concluído. Clique em "Trocar conta" novamente para tentar outra vez.'
      )
    } finally {
      setClaudeBusy(false)
    }
  }

  const current = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title settings-title">
          <IconSettings size={17} />
          Configurações
        </h3>

        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-label="Seções das configurações">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`settings-nav-item${tab === t.id ? ' on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="settings-nav-icon">{t.icon}</span>
                <span className="settings-nav-text">
                  <span className="settings-nav-label">{t.label}</span>
                  <span className="settings-nav-hint">{t.hint}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-scroll" role="tabpanel" key={tab}>
            <header className="settings-pane-head">
              <h4>{current.label}</h4>
              <span>{current.hint}</span>
            </header>

            {tab === 'geral' && (
              <>
                <section className={`settings-section settings-switch-section ${skipPerms ? 'on' : ''}`}>
                  <label className="settings-switch-row">
                    <span className="settings-switch-text">
                      <strong>
                        <IconUnlock size={15} /> Permitir tudo
                      </strong>
                      <span className="settings-desc">
                        Executa todas as ferramentas sem pedir confirmação, em todas as conversas. Aplica na
                        hora e fica salvo entre reinícios — use com cuidado.
                      </span>
                    </span>
                    <input
                      className="switch-input"
                      type="checkbox"
                      checked={skipPerms}
                      onChange={(e) => onToggleSkipPerms(e.target.checked)}
                    />
                    <span className="switch-visual" aria-hidden="true" />
                  </label>
                </section>

                <section className={`settings-section windows-control-section ${windowsControlEnabled ? 'on' : ''}`}>
                  <label className="settings-switch-row">
                    <span className="settings-switch-text">
                      <strong>
                        <IconMonitor size={15} /> Permitir controle do Windows
                      </strong>
                      <span className="settings-desc">
                        Permite que o agente veja janelas e controle mouse e teclado em outros aplicativos. É uma
                        permissão independente e mais perigosa; enquanto ativa, um aviso ficará sempre visível no app.
                      </span>
                    </span>
                    <input
                      className="switch-input"
                      type="checkbox"
                      checked={windowsControlEnabled}
                      onChange={(event) => onToggleWindowsControl(event.target.checked)}
                    />
                    <span className="switch-visual" aria-hidden="true" />
                  </label>
                </section>
              </>
            )}

            {tab === 'modelos' && (
              <>
                <section className="settings-section">
                  <div className="settings-row">
                    <span>
                      <strong>Claude (Anthropic)</strong>
                      <span className="settings-desc">
                        Desconecta a conta atual (removendo os caches de login), confirma que a máquina ficou
                        deslogada e abre o login para você entrar com outra conta ou organização.
                      </span>
                    </span>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={switchClaudeAccount}
                      disabled={claudeBusy}
                    >
                      {claudeBusy ? 'Trocando…' : 'Trocar conta'}
                    </button>
                  </div>
                </section>

                <section className={`settings-section ${codex.connected ? 'settings-connected' : ''}`}>
                  <div className="settings-row">
                    <span>
                      <strong>GPT (assinatura ChatGPT Plus/Pro/Team)</strong>
                      <span className="settings-desc">
                        Adiciona modelos GPT ao seletor, cobrados pela sua ASSINATURA do ChatGPT (não por
                        API key). Conecte com a mesma conta que você usa no ChatGPT/Codex — o uso entra na
                        sua cota do plano, sujeita ao limite semanal dele. Recurso experimental: usa um
                        mecanismo não-oficial e pode parar de funcionar se a OpenAI mudar algo do lado dela.
                      </span>
                    </span>
                  </div>
                  <div className="settings-row">
                    {codex.connected ? (
                      <>
                        <span className="settings-hint">
                          <span className="settings-status-dot" aria-hidden="true" />
                          Conectado{codex.email ? ` como ${codex.email}` : ''}
                          {codex.planType ? ` (plano ${codex.planType})` : ''}.
                        </span>
                        <button className="btn ghost" type="button" onClick={disconnectCodex} disabled={codexBusy}>
                          Desconectar
                        </button>
                      </>
                    ) : (
                      <button className="btn primary" type="button" onClick={connectCodex} disabled={codexBusy}>
                        {codexBusy ? 'Conectando…' : 'Conectar com ChatGPT'}
                      </button>
                    )}
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-row">
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={cfg.ollama.enabled}
                        disabled={!loaded}
                        onChange={(e) => setCfg((c) => ({ ...c, ollama: { ...c.ollama, enabled: e.target.checked } }))}
                      />
                      <span>
                        <strong>Ollama Cloud</strong>
                        <span className="settings-desc">
                          Adiciona modelos do Ollama Cloud ao seletor de modelo. Eles rodam pela API compatível
                          com a Anthropic do Ollama e usam a sua API key — não precisam do login do Claude.
                          GPT-OSS e Gemma 4 funcionam no plano grátis; Nemotron 3 Ultra/Super, DeepSeek V4 Pro,
                          GLM 5.3 e Kimi K3 exigem assinatura do Ollama (ollama.com/upgrade).
                        </span>
                      </span>
                    </label>
                  </div>

                  <label className="settings-field">
                    <span className="settings-field-label">API key do Ollama</span>
                    <div className="settings-key-row">
                      <input
                        className="settings-input"
                        type={showOllamaKey ? 'text' : 'password'}
                        value={cfg.ollama.apiKey}
                        placeholder="Cole a key de ollama.com → Settings → Keys"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!loaded}
                        onChange={(e) => setCfg((c) => ({ ...c, ollama: { ...c.ollama, apiKey: e.target.value } }))}
                      />
                      <RevealButton shown={showOllamaKey} onToggle={() => setShowOllamaKey((v) => !v)} />
                    </div>
                    <span className="settings-hint">
                      Gere em ollama.com → ícone de perfil → Settings → Keys. Depois de salvar, escolha um
                      modelo Ollama no seletor acima do chat (pare a sessão para trocar). A chave fica salva só
                      no seu computador (no banco da pasta de dados).
                    </span>
                  </label>
                </section>
              </>
            )}

            {tab === 'voz' && (
              <>
                <section className={`settings-section ${focus === 'openai' ? 'settings-highlight' : ''}`}>
                  <label className="settings-field">
                    <span className="settings-field-label">API key da OpenAI</span>
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
                      <RevealButton shown={showOpenAiKey} onToggle={() => setShowOpenAiKey((v) => !v)} />
                    </div>
                    <span className="settings-hint">
                      Gere em platform.openai.com → API keys. Habilita falar para escrever (transcrição,
                      gpt-4o-transcribe) e ouvir as respostas (gpt-4o-mini-tts). Usada só para voz — os
                      modelos GPT do chat usam a assinatura do ChatGPT, não esta chave. Fica salva só no seu
                      computador (no banco da pasta de dados).
                    </span>
                  </label>
                </section>

                <section className="settings-section">
                  <span className="settings-field-label">Leitura em voz alta</span>
                  <div className="settings-key-row settings-voice-row">
                    <label className="settings-field settings-field-inline">
                      <span className="settings-field-label">Voz</span>
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

                {/* Onde a fala vira texto. O modo local não usa a chave nem manda áudio
                    para lugar nenhum — em troca, baixa o reconhecimento na 1ª vez. */}
                <section className="settings-section">
                  <div className="settings-field">
                    <span className="settings-field-label">Transcrição do microfone</span>
                    <div className="settings-engine-row">
                      <button
                        type="button"
                        className={`settings-engine${cfg.transcribeEngine === 'cloud' ? ' on' : ''}`}
                        disabled={!loaded}
                        onClick={() => setCfg((c) => ({ ...c, transcribeEngine: 'cloud' }))}
                      >
                        <strong>Na nuvem</strong>
                        <span>usa sua chave da OpenAI, sem instalar nada</span>
                      </button>
                      <button
                        type="button"
                        className={`settings-engine${cfg.transcribeEngine === 'local' ? ' on' : ''}`}
                        disabled={!loaded}
                        onClick={() => setCfg((c) => ({ ...c, transcribeEngine: 'local' }))}
                      >
                        <strong>Neste computador</strong>
                        <span>funciona offline e o áudio não sai daqui</span>
                      </button>
                    </div>
                    {cfg.transcribeEngine === 'local' && (
                      <>
                        <select
                          className="settings-input"
                          value={cfg.localSpeech.model}
                          disabled={!loaded}
                          onChange={(e) => setCfg((c) => ({ ...c, localSpeech: { model: e.target.value } }))}
                        >
                          {LOCAL_SPEECH_MODELS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {`${m.label} — ${m.note} (~${m.sizeMb} MB)`}
                            </option>
                          ))}
                        </select>
                        <span className="settings-hint">
                          Na primeira vez que você falar, o app baixa o reconhecimento de voz e mostra o
                          progresso. Depois disso ele fica salvo e funciona sem internet.
                        </span>
                      </>
                    )}
                  </div>
                </section>
              </>
            )}

            {tab === 'dados' && (
              <>
                <section className="settings-section">
                  <label className="settings-field">
                    <span className="settings-field-label">Pasta de dados (cache)</span>
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

                <PostgresSettingsSection />
              </>
            )}
          </div>
        </div>

        <div className="modal-actions settings-actions">
          <span className="settings-actions-note">
            Interruptores e contas aplicam na hora. <strong>Salvar</strong> grava chaves, voz e Ollama.
          </span>
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
