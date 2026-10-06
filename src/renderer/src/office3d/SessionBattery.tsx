/**
 * "⚡ Energia do escritório" — o banco de baterias no canto superior esquerdo
 * do HUD (OfficeHud). A energia do prédio é a janela de 5 h da conta EM
 * DESTAQUE (accountBank.ts: a que está sendo gasta):
 *
 *   tomada  ⚡, o cabo (com agente trabalhando nela, a corrente corre na
 *           velocidade do consumo), a bateria de 10 células (as do quadro da
 *           parede), a % que resta, o nome curto e "recarrega às HH:MM"; o
 *           nível só fora da carga cheia ("Modo economia", "Bateria fraca"
 *           piscando); no apagão, vidro vermelho e "Apagão — recarrega às…";
 *   doca    as outras contas conectadas, menores e apagadas, com a % (pilha
 *           tracejada e "—" sem leitura; ponto pulsando com agente nela);
 *   quadro  (hover, clique ou Enter; Esc e clique fora fecham) uma linha por
 *           conta: 5 h, quem usa, recarga, 7 dias e a idade da leitura.
 *
 * Trocou a conta em destaque: a que entra sobe para a tomada e a doca se
 * rearranja. Sem lista de contas (instalação antiga) é a pílula de sempre:
 * "Energia do escritório" com a janela do usageLimits. Quem lê a energia é o
 * motor; aqui só se desenha. Sem dado, some.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { updatedAgo } from '../accounts/accountUsageView'
import type { BankAccount } from './accountBank'
import './battery.css'
import { POWER_LABEL, resetClock, type OfficePower, type PowerLevel } from './power'
import { useDismiss } from './ProjectFilter'

/** Quanto dura a animação da troca de bateria (ms). */
export const SWAP_MS = 600

/** Texto de ajuda da pílula: a conta, a % que resta e a usada (ou, sem contas, o da pílula de sempre). */
export function powerTitle(p: OfficePower, now: number, name: string | null = null): string {
  const used = 100 - p.pct
  if (name !== null) return `Energia do escritório: ${p.unread ? 'ainda sem leitura' : `${p.pct}% restantes`} da janela de 5 h da conta ${name}${p.unread ? '' : ` (${used}% usados)`}.`
  const time = resetClock(p.resetsAt, now)
  const recharge = time ? ` A janela recarrega às ${time}.` : ''
  return (
    `A energia do escritório são os tokens da sessão de 5h da conta: ${p.pct}% restantes (${used}% usados) — ${POWER_LABEL[p.level]}.${recharge}` +
    ' Abaixo de 50% o escritório economiza luz, abaixo de 20% as luzes piscam e em 0% falta luz (e vira festa) até recarregar.'
  )
}

/** As 10 células: acesas até a carga, a última parcial. */
function Cells({ pct }: { pct: number }): JSX.Element {
  const lit = (Math.max(0, Math.min(100, pct)) / 100) * 10
  return (
    <span className="o3d-bank-cell" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <b key={i} className={i < Math.floor(lit) ? 'on' : i < lit ? 'part' : undefined} />
      ))}
    </span>
  )
}

/** Duração de uma volta do pulso no cabo: mais rápido quanto maior o consumo (pontos por minuto). */
export function flowSeconds(drainPerMin: number, busy: number): number {
  const speed = Math.max(drainPerMin, busy * 0.4)
  return Math.round(Math.max(0.45, Math.min(2.2, 2.2 - speed * 0.5)) * 100) / 100
}

const agents = (n: number): string => `${n} agente${n > 1 ? 's' : ''} trabalhando`
const resetText = (b: BankAccount, now: number): string => (b.resetsAt === null ? 'janela de 5 h ainda sem uso' : `recarrega às ${resetClock(b.resetsAt, now)}`)
/** A leitura velha (1 min ou mais) mostra a idade. */
const ageText = (b: BankAccount, now: number): string | null => (b.at !== null && now - b.at >= 60_000 ? updatedAgo(b.at, now) : null)

function Spare({ b, now }: { b: BankAccount; now: number }): JSX.Element {
  const tip = b.pct === null ? `${b.name}: sem leitura ainda` : [`${b.name}: ${b.pct}% restantes`, b.busy ? agents(b.busy) : 'parada', resetText(b, now), ageText(b, now)].filter(Boolean).join(' · ')
  return (
    <span className={`o3d-bank-spare${b.busy ? ' busy' : ''}${b.pct === null ? ' none' : ''}`} data-level={b.level ?? 'cheia'} title={tip} data-testid="o3d-bank-spare">
      <span className="o3d-bank-mini" aria-hidden="true">
        <i style={{ height: `${b.pct ?? 0}%` }} />
      </span>
      <span className="o3d-bank-spct">{b.pct === null ? '—' : `${b.pct}%`}</span>
      <span className="o3d-bank-sname">{b.name}</span>
    </span>
  )
}

function Row({ b, featured, now }: { b: BankAccount; featured: boolean; now: number }): JSX.Element {
  const tag = featured ? <span className="o3d-bank-tag">em destaque</span> : b.busy ? <span className="o3d-bank-tag use">em uso</span> : <span className="o3d-bank-tag ghost">parada</span>
  const meta = b.pct === null ? 'sem leitura ainda' : [b.busy ? agents(b.busy) : null, resetText(b, now), b.weekUsed !== null ? `7 dias: ${b.weekUsed}% usados` : null, ageText(b, now)].filter(Boolean).join(' · ')
  const on = Math.round((b.pct ?? 0) / 5)
  return (
    <div className={`o3d-bank-row${featured ? ' active' : ''}`} data-level={b.level ?? 'cheia'} data-testid="o3d-bank-row">
      <span className="o3d-bank-row-name">
        {b.name}
        {b.email && <small>{b.email}</small>}
      </span>
      <span className="o3d-bank-row-pct">{b.pct === null ? '—' : `${b.pct}%`}</span>
      <span className="o3d-bank-row-bar" aria-hidden="true">
        {Array.from({ length: 20 }, (_, i) => (
          <b key={i} className={i < on ? 'on' : undefined} />
        ))}
      </span>
      <span className="o3d-bank-row-meta">
        {tag}
        {meta}
      </span>
    </div>
  )
}

export function SessionBattery({ power, now = Date.now() }: { power: OfficePower | null; now?: number }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [swap, setSwap] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const lastId = useRef<string | null | undefined>(undefined)
  const accountId = power?.accountId ?? null
  useDismiss(open, () => setOpen(false), box)
  // A conta em destaque mudou: a troca de bateria (a que entra sobe para a tomada).
  useEffect(() => {
    const prev = lastId.current
    lastId.current = accountId
    if (prev === undefined || prev === accountId || accountId === null) return
    setSwap(true)
    const t = setTimeout(() => setSwap(false), SWAP_MS)
    return () => clearTimeout(t)
  }, [accountId])
  if (!power) return null

  const level: PowerLevel = power.level
  const bank = power.bank
  const featured = bank.find((b) => b.id === accountId) ?? null
  const spares = bank.filter((b) => b.id !== accountId)
  const time = resetClock(power.resetsAt, now)
  const out = level === 'apagao'
  const flowing = !!featured && featured.busy > 0 && !out
  const pctText = power.unread ? '—' : `${power.pct}%`
  const reset = out ? (time ? `Apagão — recarrega às ${time}` : 'Apagão — recarrega na próxima janela') : time ? `recarrega às ${time}` : ''
  const style = { '--o3d-flow': `${flowSeconds(power.drainPerMin, featured?.busy ?? 0)}s` } as CSSProperties
  const cls = ['o3d-glass', 'o3d-bank', flowing && 'flowing', swap && 'swap', open && 'open'].filter(Boolean).join(' ')

  return (
    <div
      ref={box}
      className={cls}
      style={style}
      data-testid="o3d-session-battery"
      data-level={level}
      data-account={accountId ?? undefined}
      onMouseEnter={() => bank.length > 0 && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="o3d-bank-main"
        aria-haspopup={bank.length > 0 ? 'dialog' : undefined}
        aria-expanded={bank.length > 0 ? open : undefined}
        title={powerTitle(power, now, featured?.name ?? null)}
        onClick={() => bank.length > 0 && setOpen((v) => !v)}
      >
        <svg className="o3d-bank-bolt" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
        </svg>
        <span className="o3d-bank-cable" aria-hidden="true" />
        <Cells pct={power.unread ? 0 : power.pct} />
        <span className="o3d-bank-pct">{pctText}</span>
        <span className="o3d-bank-who">{featured ? featured.name : 'Energia do escritório'}</span>
        {level !== 'cheia' && !out && <span className="o3d-bank-lvl">{POWER_LABEL[level]}</span>}
        {reset && <span className={out ? 'o3d-bank-lvl' : 'o3d-bank-reset'}>{reset}</span>}
      </button>
      {spares.length > 0 && (
        <span className="o3d-bank-dock" aria-label="Outras contas conectadas" role="group">
          {spares.map((b) => (
            <Spare key={b.id} b={b} now={now} />
          ))}
        </span>
      )}
      {open && bank.length > 0 && (
        <div className="o3d-bank-pop" role="dialog" aria-label="Quadro de energia" data-testid="o3d-bank-pop">
          <div className="o3d-bank-pop-title">Quadro de energia · janela de 5 h</div>
          {[...(featured ? [featured] : []), ...spares].map((b) => (
            <Row key={b.id} b={b} featured={b.id === accountId} now={now} />
          ))}
          <p className="o3d-bank-pop-foot">% que resta de cada conta conectada. As contas paradas são relidas a cada 5 min, sem gastar limite.</p>
        </div>
      )}
    </div>
  )
}
