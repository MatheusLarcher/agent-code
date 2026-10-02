/**
 * "⚡ Energia do escritório" na barra do modo 3D: a energia do prédio são os
 * tokens da sessão de 5h da conta (a mesma janela `five_hour` do "Sessão 5h"
 * do cabeçalho, battery.ts/power.ts). Mostra a %, o nível (cheia, modo
 * economia, bateria fraca, apagão) e a hora do reset; no apagão, "Apagão —
 * volta às HH:MM". Quem lê a energia é o motor (a mesma leitura que acende e
 * apaga a cena, com o override de DEV); aqui só se desenha. Sem dado, some.
 */
import { LEVEL_COLORS, POWER_LABEL, resetClock, type OfficePower } from './power'

/** Texto de ajuda: o que é a energia e o que cada faixa faz no escritório. */
export function powerTitle(p: OfficePower, now: number): string {
  const time = resetClock(p.resetsAt, now)
  const used = 100 - p.pct
  const reset = time ? ` A janela reseta às ${time}.` : ''
  return (
    `A energia do escritório são os tokens da sessão de 5h da conta: ${p.pct}% restantes (${used}% usados) — ${POWER_LABEL[p.level]}.${reset}` +
    ' Abaixo de 50% o escritório economiza luz, abaixo de 20% as luzes piscam e em 0% falta luz (e vira festa) até o reset.'
  )
}

export function SessionBattery({ power, now = Date.now() }: { power: OfficePower | null; now?: number }): JSX.Element | null {
  if (!power) return null
  const time = resetClock(power.resetsAt, now)
  const out = power.level === 'apagao'
  const color = LEVEL_COLORS[power.level]
  return (
    <div className={`o3d-battery o3d-power-${power.level}`} title={powerTitle(power, now)} data-testid="o3d-session-battery" data-level={power.level}>
      <span className="o3d-battery-cap">⚡ Energia do escritório</span>
      <span className="o3d-battery-body" aria-hidden="true">
        <span className="o3d-battery-fill" style={{ width: `${power.pct}%`, background: color }} />
      </span>
      <span className="o3d-battery-val">{power.pct}%</span>
      {out ? (
        <span className="o3d-battery-level">{time ? `Apagão — volta às ${time}` : 'Apagão — volta no reset'}</span>
      ) : (
        <>
          <span className="o3d-battery-level">{POWER_LABEL[power.level]}</span>
          {time && <span className="o3d-battery-reset">reseta {time}</span>}
        </>
      )}
    </div>
  )
}
