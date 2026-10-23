import type { Dispatch, SetStateAction } from 'react'
import {
  AUTO_MODE_CLASSIFIER_MODELS,
  DEFAULT_AUTO_MODE_CLASSIFIER_MODEL,
  type AppConfig,
  type AutoModeClassifierModel
} from '@shared/ipc'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  /** Grava só o campo alterado (o patchConfig do SettingsModal). */
  patchConfig: (patch: { autoModeClassifierModel: AutoModeClassifierModel }) => Promise<void>
}

/**
 * Modelo do classificador do modo automático (aba Geral). Hoje só as sessões
 * do PO com ferramentas rodam em modo automático; o chat normal pergunta.
 */
export function AutoModeClassifierSetting({ cfg, setCfg, patchConfig }: Props): JSX.Element {
  const value = cfg.autoModeClassifierModel ?? DEFAULT_AUTO_MODE_CLASSIFIER_MODEL

  return (
    <section className="settings-section">
      <div className="settings-row">
        <span>
          <strong>Modelo do classificador do modo automático</strong>
          <span className="settings-desc">
            Decide se uma ação do agente pode rodar sem perguntar nas sessões em modo automático (o PO
            quando olha o projeto). Automático deixa o Claude escolher.
          </span>
        </span>
        <select
          className="settings-input"
          aria-label="Modelo do classificador do modo automático"
          value={value}
          onChange={(event) => {
            const autoModeClassifierModel = event.target.value as AutoModeClassifierModel
            setCfg((c) => ({ ...c, autoModeClassifierModel }))
            void patchConfig({ autoModeClassifierModel })
          }}
        >
          {AUTO_MODE_CLASSIFIER_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  )
}
