import type { Dispatch, SetStateAction } from 'react'
import type { AppConfig, HandoffConfig } from '@shared/ipc'
import { IconRefresh, IconZap } from '../components/Icons'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  /** Grava só o campo alterado (o patchConfig do SettingsModal). */
  patchConfig: (patch: { handoff: Partial<HandoffConfig> }) => Promise<void>
}

/**
 * Os interruptores do "Enviar para implementação" (AppConfig.handoff), na aba
 * Geral. Valem para os handoffs e conversas de implementação NOVOS; desligar não
 * mexe no que já foi enviado.
 */
export function HandoffSettingsSection({ cfg, setCfg, patchConfig }: Props): JSX.Element {
  const set = (patch: Partial<HandoffConfig>): void => {
    setCfg((c) => ({ ...c, handoff: { ...c.handoff, ...patch } }))
    void patchConfig({ handoff: patch })
  }
  return (
    <>
      <section className={`settings-section settings-switch-section ${cfg.handoff.ciclo ? 'on' : ''}`}>
        <label className="settings-switch-row">
          <span className="settings-switch-text">
            <strong>
              <IconRefresh size={15} /> Ciclo completo nos handoffs
            </strong>
            <span className="settings-desc">
              Todo plano enviado para implementação pede o ciclo plan → test → implement → review → verify → remember →
              improve em cada etapa: teste que falha antes do código, revisão do diff, verificação com o app rodando,
              memória do que foi aprendido e uma autoavaliação no fim. Vale para os próximos envios. Liga também as
              skills desse ciclo (verification-loop e agent-self-evaluation), que saem na hora ao desligar.
            </span>
          </span>
          <input
            className="switch-input"
            type="checkbox"
            checked={cfg.handoff.ciclo}
            onChange={(event) => set({ ciclo: event.target.checked })}
          />
          <span className="switch-visual" aria-hidden="true" />
        </label>
      </section>

      <section className={`settings-section settings-switch-section ${cfg.handoff.leituraGuiada ? 'on' : ''}`}>
        <label className="settings-switch-row">
          <span className="settings-switch-text">
            <strong>
              <IconZap size={15} /> Leitura guiada na implementação
            </strong>
            <span className="settings-desc">
              Cada prompt de handoff abre com uma seção "Arquivos" no topo (o que ler e o que editar, conferido no
              código durante o planejamento) e manda a implementação abrir essa lista de uma vez, em paralelo, em vez
              de explorar o projeto arquivo por arquivo. O envio para implementação também ganha a opção de Fast mode,
              que começa com a escolha das conversas do projeto. Desligada, tudo fica como antes. Vale para os
              próximos envios.
            </span>
          </span>
          <input
            className="switch-input"
            type="checkbox"
            checked={cfg.handoff.leituraGuiada}
            onChange={(event) => set({ leituraGuiada: event.target.checked })}
          />
          <span className="switch-visual" aria-hidden="true" />
        </label>
      </section>
    </>
  )
}
