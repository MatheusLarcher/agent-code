/**
 * Botão grande "Conectar conta" no chat, só quando NENHUM provedor (Claude,
 * GPT, Ollama, DeepSeek, Kimi) está conectado. Conecta ali mesmo, reaproveitando os
 * fluxos que já existem em Configurações:
 * - Claude e GPT: o login OAuth existente (abre o navegador do sistema); o card
 *   fica "Aguardando…" até o login voltar.
 * - Ollama, DeepSeek e Kimi: cola a API key e grava a config (`<provedor>.enabled` + chave);
 *   a do Kimi passa antes pelo "Testar conexão" (mesmo do Configurações).
 *
 * "Cancelar" não mata o login do navegador (o fluxo existente não tem cancelar):
 * só devolve o card ao início e ignora o resultado que chegar depois.
 */
import { useEffect, useRef, useState } from 'react'
import type { ProvidersStatus } from '@shared/ipc'
import { useUI } from '../../ui/UiProvider'
import { hasAnyProvider, PROVIDER_LABEL, type ProviderId } from './providerModels'
import './connectAccount.css'

interface Props {
  /** null enquanto o main não respondeu — o card não aparece na dúvida inicial. */
  status: ProvidersStatus | null
  /** Conectou: o App ajusta o modelo da conversa ativa. */
  onConnected: (provider: ProviderId) => void
  /** Conversa vazia: centralizado; com mensagens: acima do campo de mensagem. */
  compact?: boolean
}

type KeyProvider = 'ollama' | 'deepseek' | 'kimi'
type Phase =
  | { kind: 'idle' }
  | { kind: 'menu' }
  | { kind: 'waiting'; provider: 'claude' | 'gpt' }
  | { kind: 'key'; provider: KeyProvider }

/** Onde gerar a chave de cada provedor por API key. */
const KEY_LINK: Record<KeyProvider, { href: string; label: string }> = {
  ollama: { href: 'https://ollama.com/settings/keys', label: 'Gerar chave no ollama.com' },
  deepseek: { href: 'https://platform.deepseek.com/api_keys', label: 'Gerar chave na DeepSeek' },
  kimi: { href: 'https://www.kimi.ai/code/console', label: 'Gerar chave no console do Kimi Code' }
}

/** Config gravada para a chave de cada provedor. A do Kimi só vale depois do
 *  teste de conexão (região, janela e modelos que o plano libera). */
async function keyConfig(provider: KeyProvider, apiKey: string): Promise<Parameters<typeof window.api.setConfig>[0]> {
  if (provider === 'ollama') return { ollama: { enabled: true, apiKey } }
  if (provider === 'deepseek') return { deepseek: { enabled: true, apiKey } }
  const r = await window.api.kimiTestConnection(apiKey)
  if (!r.ok) throw new Error(r.message)
  const current = (await window.api.getConfig()).kimi
  return {
    kimi: {
      ...current,
      enabled: true,
      apiKey,
      region: r.region ?? current.region,
      contextWindow: r.contextWindow ?? current.contextWindow,
      models: r.models ?? []
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function ConnectAccountCard({ status, onConnected, compact }: Props): JSX.Element | null {
  const { notify } = useUI()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  // Cada tentativa ganha um número; Cancelar ou desmontar invalida a atual.
  const attempt = useRef(0)
  useEffect(() => () => void (attempt.current += 1), [])

  if (!status || hasAnyProvider(status)) return null

  /** Confirma no main (o login pode "voltar ok" sem conta utilizável). */
  const confirm = async (provider: ProviderId, token: number): Promise<void> => {
    const fresh = await window.api.providersStatus().catch(() => null)
    if (token !== attempt.current) return
    if (fresh?.[provider]) {
      notify('sucesso', `Conta conectada: ${PROVIDER_LABEL[provider]}`)
      onConnected(provider)
    } else {
      notify('erro', `Não foi possível confirmar a conexão com ${PROVIDER_LABEL[provider]}.`)
    }
    setPhase({ kind: 'idle' })
  }

  const login = async (provider: 'claude' | 'gpt'): Promise<void> => {
    const token = ++attempt.current
    setPhase({ kind: 'waiting', provider })
    try {
      const result = provider === 'claude' ? await window.api.authLogin() : await window.api.codexLogin()
      if (token !== attempt.current) return
      if (!result.ok) {
        const message = 'message' in result && result.message ? `: ${result.message}` : '.'
        notify('erro', `Login no ${PROVIDER_LABEL[provider]} não concluído${message}`)
        setPhase({ kind: 'idle' })
        return
      }
      await confirm(provider, token)
    } catch (err) {
      if (token !== attempt.current) return
      notify('erro', `Login no ${PROVIDER_LABEL[provider]} falhou: ${errorText(err)}`)
      setPhase({ kind: 'idle' })
    }
  }

  const cancel = (): void => {
    attempt.current += 1
    setPhase({ kind: 'idle' })
    notify('aviso', 'Login cancelado. Se o navegador ainda estiver aberto, pode fechá-lo.')
  }

  const saveKey = async (provider: KeyProvider): Promise<void> => {
    const apiKey = apiKeyInput.trim()
    if (!apiKey) return
    const token = ++attempt.current
    setSaving(true)
    try {
      const patch = await keyConfig(provider, apiKey)
      if (token !== attempt.current) return
      await window.api.setConfig(patch)
      if (token !== attempt.current) return
      setApiKeyInput('')
      await confirm(provider, token)
    } catch (err) {
      if (token === attempt.current) notify('erro', `Não foi possível salvar a chave do ${PROVIDER_LABEL[provider]}: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`connect-account ${compact ? 'compact' : ''}`}>
      {phase.kind === 'idle' && (
        <>
          <p className="connect-account-text">Conecte uma conta para conversar com o agente.</p>
          <button className="btn primary connect-account-main" onClick={() => setPhase({ kind: 'menu' })}>
            Conectar conta
          </button>
        </>
      )}
      {phase.kind === 'menu' && (
        <div className="connect-account-options">
          <button className="btn" onClick={() => void login('claude')}>Claude</button>
          <button className="btn" onClick={() => void login('gpt')}>GPT</button>
          <button className="btn" onClick={() => setPhase({ kind: 'key', provider: 'ollama' })}>Ollama</button>
          <button className="btn" onClick={() => setPhase({ kind: 'key', provider: 'deepseek' })}>DeepSeek</button>
          <button className="btn" onClick={() => setPhase({ kind: 'key', provider: 'kimi' })}>Kimi</button>
          <button className="btn ghost" onClick={() => setPhase({ kind: 'idle' })} aria-label="Voltar">
            Voltar
          </button>
        </div>
      )}
      {phase.kind === 'waiting' && (
        <div className="connect-account-waiting">
          <span>Aguardando login no navegador…</span>
          <button className="btn" onClick={cancel}>Cancelar</button>
        </div>
      )}
      {phase.kind === 'key' && (
        <form
          className="connect-account-ollama"
          onSubmit={(e) => {
            e.preventDefault()
            void saveKey(phase.provider)
          }}
        >
          <input
            type="password"
            aria-label={`API key do ${PROVIDER_LABEL[phase.provider]}`}
            placeholder={`Cole a API key do ${PROVIDER_LABEL[phase.provider]}`}
            value={apiKeyInput}
            autoFocus
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          {/* target=_blank: o main abre links novos no navegador do sistema. */}
          <a href={KEY_LINK[phase.provider].href} target="_blank" rel="noreferrer">
            {KEY_LINK[phase.provider].label}
          </a>
          <div className="connect-account-actions">
            <button type="submit" className="btn primary" disabled={!apiKeyInput.trim() || saving}>
              Salvar
            </button>
            <button type="button" className="btn ghost" onClick={() => setPhase({ kind: 'menu' })}>
              Voltar
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
