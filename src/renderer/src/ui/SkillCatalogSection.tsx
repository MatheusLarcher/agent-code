import './skillCatalog.css'
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  SKILL_CATEGORIES,
  type AppConfig,
  type SkillCatalogConfig,
  type SkillCategory,
  type SkillTier,
  type SkillTierRow
} from '@shared/ipc'
import { ipcErrorMessage } from '../ipcError'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  /** Grava só o campo alterado (o patchConfig do SettingsModal). */
  patchConfig: (patch: { skillCatalog: Partial<SkillCatalogConfig> }) => Promise<void>
}

const TIER_LABEL: Record<SkillTier, string> = { critical: 'Crítica', medium: 'Média', low: 'Baixa' }
const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * Aba Skills: o interruptor do catálogo em níveis (desligado = como antes) e o
 * nível e a categoria de cada skill. Os ajustes valem para as conversas novas.
 */
export function SkillCatalogSection({ cfg, setCfg, patchConfig }: Props): JSX.Element {
  const [rows, setRows] = useState<SkillTierRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let alive = true
    window.api
      .skillTierList()
      .then((list) => alive && setRows(list))
      .catch((e) => alive && setError(ipcErrorMessage(e, 'erro desconhecido')))
    return () => {
      alive = false
    }
  }, [])

  const overrides = cfg.skillCatalog.overrides
  const shown = useMemo(() => {
    const q = fold(filter.trim())
    return (rows ?? []).filter((r) => !q || fold(r.name).includes(q) || fold(r.category).includes(q))
  }, [rows, filter])

  const setTiered = (tiered: boolean): void => {
    setCfg((c) => ({ ...c, skillCatalog: { ...c.skillCatalog, tiered } }))
    void patchConfig({ skillCatalog: { tiered } })
  }

  // Ajuste igual ao padrão do índice sai do mapa: "voltar ao padrão" é só escolher o padrão.
  const choose = (row: SkillTierRow, tier: SkillTier, category: SkillCategory): void => {
    const next = { ...overrides }
    if (tier === row.defaultTier && category === row.defaultCategory) delete next[row.name]
    else next[row.name] = { tier, category }
    setCfg((c) => ({ ...c, skillCatalog: { ...c.skillCatalog, overrides: next } }))
    void patchConfig({ skillCatalog: { overrides: next } })
  }

  const current = (row: SkillTierRow): { tier: SkillTier; category: SkillCategory } =>
    overrides[row.name] ?? { tier: row.defaultTier, category: row.defaultCategory }

  return (
    <>
      <section className={`settings-section settings-switch-section ${cfg.skillCatalog.tiered ? 'on' : ''}`}>
        <label className="settings-switch-row">
          <span className="settings-switch-text">
            <strong>Catálogo de skills em níveis</strong>
            <span className="settings-desc">
              Em vez de mandar todas as skills ao modelo em todo pedido: a crítica vai inteira no prompt, as médias como
              hoje e as baixas só o nome, por categoria — o agente acha a baixa por uma busca e lê o SKILL.md. Liga
              também as skills da curadoria do ECC. Desligado, tudo fica como antes. Vale para as conversas novas.
            </span>
          </span>
          <input className="switch-input" type="checkbox" checked={cfg.skillCatalog.tiered} onChange={(e) => setTiered(e.target.checked)} />
          <span className="switch-visual" aria-hidden="true" />
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-row">
          <span>
            <strong>Nível e categoria de cada skill</strong>
            <span className="settings-desc">Skill nova entra como média até você classificar.</span>
          </span>
          <input className="settings-input" type="search" placeholder="Filtrar skills" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {error && <span className="settings-warn" role="alert">Não foi possível listar as skills: {error}</span>}
        {!rows && !error && <span className="settings-hint">Lendo as skills…</span>}
        {rows && (
          <table className="skill-tier-table">
            <tbody>
              {shown.map((row) => {
                const value = current(row)
                return (
                  <tr key={row.name} aria-label={row.name}>
                    <td title={row.description}>
                      <code>{row.name}</code>
                      {row.fromEcc && <span className="skill-tier-badge">ECC</span>}
                      {overrides[row.name] && <span className="skill-tier-badge on">ajustada</span>}
                    </td>
                    <td>
                      <select
                        className="settings-input"
                        aria-label={`Nível de ${row.name}`}
                        value={value.tier}
                        onChange={(e) => choose(row, e.target.value as SkillTier, value.category)}
                      >
                        {(Object.keys(TIER_LABEL) as SkillTier[]).map((t) => (
                          <option key={t} value={t}>
                            {TIER_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="settings-input"
                        aria-label={`Categoria de ${row.name}`}
                        value={value.category}
                        onChange={(e) => choose(row, value.tier, e.target.value as SkillCategory)}
                      >
                        {SKILL_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}
