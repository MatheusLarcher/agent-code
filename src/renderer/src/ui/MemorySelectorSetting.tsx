import type { Dispatch, SetStateAction } from 'react'
import type { AppConfig } from '@shared/ipc'
import { IconDatabase } from '../components/Icons'

export type MemorySelector = 'haiku' | 'typesafe'

/** `memorySelector` é top-level em AppConfig (padrão 'haiku'). A leitura tolera
 *  config antiga sem o campo — cai no Haiku. */
type CfgWithSelector = AppConfig & { memorySelector?: MemorySelector }

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  /** Grava só o campo alterado (o patchConfig do SettingsModal). */
  patchConfig: (patch: { memorySelector: MemorySelector }) => Promise<void>
}

const OPTIONS: { id: MemorySelector; label: string; desc: string }[] = [
  {
    id: 'haiku',
    label: 'Haiku',
    desc: 'O Haiku lê os cabeçalhos de todas as memórias e a conversa e escolhe até 15 para o agente e os subagentes.'
  },
  {
    id: 'typesafe',
    label: 'TypeSafe',
    desc: 'O TypeSafe escolhe até 3 memórias só pela mensagem.'
  }
]

/**
 * Quem escolhe as memórias que entram no turno (aba Geral). Escolher o TypeSafe
 * sem ele configurado não é bloqueado: o main segue no Haiku até a chave existir,
 * e a tela só avisa.
 */
export function MemorySelectorSetting({ cfg, setCfg, patchConfig }: Props): JSX.Element {
  const value: MemorySelector = (cfg as CfgWithSelector).memorySelector ?? 'haiku'
  const typeSafeReady = cfg.typesafe.enabled && cfg.typesafe.apiKey.trim() !== ''

  const choose = (memorySelector: MemorySelector): void => {
    setCfg((c) => ({ ...c, memorySelector }) as AppConfig)
    void patchConfig({ memorySelector })
  }

  return (
    <section className="settings-section">
      <span className="settings-switch-text">
        <strong>
          <IconDatabase size={15} /> Seleção de memórias
        </strong>
        <span className="settings-desc">Quem escolhe as memórias que acompanham cada mensagem.</span>
      </span>
      <div className="settings-memory-selector" role="radiogroup" aria-label="Seleção de memórias">
        {OPTIONS.map((o) => (
          <label key={o.id} className="settings-checkbox-row settings-memory-selector-option">
            <input
              type="radio"
              name="memory-selector"
              value={o.id}
              checked={value === o.id}
              onChange={() => choose(o.id)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="settings-desc">{o.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {value === 'typesafe' && !typeSafeReady && (
        <span className="settings-warn" role="status">
          O TypeSafe não está configurado — o Haiku segue escolhendo até você ativá-lo.
        </span>
      )}
    </section>
  )
}
