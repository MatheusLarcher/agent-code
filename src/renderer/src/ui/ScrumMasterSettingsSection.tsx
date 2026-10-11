import type { Dispatch, SetStateAction } from 'react'
import { PO_MODELS, scrumMasterConfig, type AppConfig, type ScrumMasterConfig } from '@shared/ipc'
import { IconClock } from '../components/Icons'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  /** Grava só o campo alterado (o patchConfig do SettingsModal). */
  patchConfig: (patch: { board: { scrumMaster: Partial<ScrumMasterConfig> } }) => Promise<void>
}

/**
 * O Scrum Master (AppConfig.board.scrumMaster), logo depois do PO na aba Geral.
 * Desligado, nada acontece: nenhum marco, nenhuma consulta, nenhuma cobrança.
 */
export function ScrumMasterSettingsSection({ cfg, setCfg, patchConfig }: Props): JSX.Element {
  const sm = scrumMasterConfig(cfg.board)
  const set = (patch: Partial<ScrumMasterConfig>): void => {
    setCfg((c) => ({ ...c, board: { ...c.board, scrumMaster: { ...scrumMasterConfig(c.board), ...patch } } }))
    void patchConfig({ board: { scrumMaster: patch } })
  }
  return (
    <section className={`settings-section settings-switch-section ${sm.enabled ? 'on' : ''}`}>
      <label className="settings-switch-row">
        <span className="settings-switch-text">
          <strong>
            <IconClock size={15} /> Scrum Master — cobrar a etapa atrasada
          </strong>
          <span className="settings-desc">
            Nos envios para implementação com prazo, quando a etapa passa de 1,5×, 2× e 3× do prazo, ele lê as respostas
            do agente e cobra uma ação concreta na própria conversa. Agente travado é interrompido e recebe a cobrança
            como mensagem. A partir de 2× do prazo, você recebe um aviso.
          </span>
        </span>
        <input className="switch-input" type="checkbox" checked={sm.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
        <span className="switch-visual" aria-hidden="true" />
      </label>
      {sm.enabled && (
        <>
          <div className="settings-row">
            <span>
              <strong>Modelo do Scrum Master</strong>
              <span className="settings-desc">Ele só lê as respostas de texto do agente e julga o atraso.</span>
            </span>
            <select className="settings-input" value={sm.model} onChange={(event) => set({ model: event.target.value })}>
              {PO_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <label className="settings-switch-row">
            <span className="settings-switch-text">
              <strong>Pode parar envios (experimental)</strong>
              <span className="settings-desc">
                No 3× do prazo, se ele julgar que seguir é desperdício claro, para o envio e a fila espera você. Uma vez
                por envio.
              </span>
            </span>
            <input className="switch-input" type="checkbox" checked={sm.podeParar} onChange={(event) => set({ podeParar: event.target.checked })} />
            <span className="switch-visual" aria-hidden="true" />
          </label>
        </>
      )}
    </section>
  )
}
