/**
 * A coluna "Recebeu" do app Contexto e o raio-X ao lado dela: cada bloco na
 * ordem em que o Agent lê, com o texto exato que o app enviou (expandir,
 * copiar) ou, para o que o app não vê, o tamanho medido pelo SDK item a item.
 * Reenvio do meio do turno com o horário e as linhas novas em verde; num turno
 * antigo, "igual" quando o texto é o mesmo do turno seguinte.
 *
 * Senhas: `nome: ••••` do tamanho real e um olho que pede o valor ATUAL ao cofre
 * (secrets:reveal, só no PC); esconde em REVEAL_MS ou ao recolher o bloco.
 * Copiar usa a versão sem o valor.
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ContextSecretMask } from '@shared/contextSnapshot'
import { countHits, fmtTokens, kb, maskedText, secretSegments, type BlockTone, type DisplayBlock } from './contextView'
import { Icon } from './icons'

export const REVEAL_MS = 30_000

export const TONE_COLOR: Record<BlockTone, string> = {
  sys: '#7aa2f7',
  msg: '#b9c2e8',
  ask: '#f4f4f4',
  docs: '#73daca',
  mem: '#ff9e64',
  sub: '#c4a7f7',
  miss: '#5a5a5a',
  link: '#5a5a5a'
}

const clockOf = (at: number): string => {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** A senha mascarada e o olho. */
export function SecretText({ name, length }: { name: string; length: number }): JSX.Element {
  const [value, setValue] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const toggle = async (): Promise<void> => {
    if (value !== null) {
      setValue(null)
      return
    }
    const api = typeof window !== 'undefined' ? window.api : undefined
    const v = typeof api?.revealSecret === 'function' ? await api.revealSecret(name).catch(() => null) : null
    if (v === null) return
    setValue(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setValue(null), REVEAL_MS)
  }
  return (
    <span className="cm-secret" title={value !== null ? 'Valor de agora no cofre: pode não ser o que foi enviado naquele turno.' : 'O valor nunca é guardado no histórico: o olho lê o cofre na hora.'}>
      <Icon name="lock" />
      <span className="cm-secret-v">{value ?? '•'.repeat(Math.max(1, length))}</span>
      <button type="button" className="cm-secret-eye" aria-label={value !== null ? `Esconder a senha ${name}` : `Mostrar a senha ${name}`} aria-pressed={value !== null} onClick={() => void toggle()}>
        <Icon name={value !== null ? 'eye-off' : 'eye'} />
      </button>
      {value !== null && <small className="cm-secret-note">valor atual do cofre</small>}
    </span>
  )
}

function Highlight({ text, q }: { text: string; q: string }): JSX.Element {
  const query = q.trim()
  if (!query) return <>{text}</>
  const parts: JSX.Element[] = []
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  let last = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > last) parts.push(<span key={`t${at}`}>{text.slice(last, at)}</span>)
    parts.push(<mark key={`m${at}`}>{text.slice(at, at + needle.length)}</mark>)
    last = at + needle.length
  }
  if (last < text.length) parts.push(<span key="end">{text.slice(last)}</span>)
  return <>{parts}</>
}

/** O texto exato, linha a linha: senhas mascaradas, busca marcada, linhas novas em verde. */
const RawText = memo(function RawText({ text, q, added, secrets }: { text: string; q: string; added?: number[]; secrets: readonly ContextSecretMask[] }): JSX.Element {
  const fresh = new Set(added ?? [])
  return (
    <pre>
      {text.split('\n').map((line, i) => (
        <span key={i} className={`cm-l${fresh.has(i) ? ' addl' : ''}`}>
          {line === ''
            ? ' '
            : secretSegments(line).map((s, k) =>
                'secret' in s ? (
                  <span key={k}>
                    <SecretText name={s.secret} length={secrets.find((x) => x.name === s.secret)?.length ?? 8} />
                  </span>
                ) : (
                  <Highlight key={k} text={s.text} q={q} />
                )
              )}
        </span>
      ))}
    </pre>
  )
})

function sizeLabel(b: DisplayBlock, exact: boolean): JSX.Element {
  if (b.text !== undefined) {
    return (
      <>
        {kb(b.bytes)}
        <small>~{fmtTokens(b.tokens)} tokens</small>
      </>
    )
  }
  if (b.measured) {
    return (
      <>
        {fmtTokens(b.tokens, exact)} tokens
        <small className="m">{exact ? 'contado' : 'medido pelo SDK'}</small>
      </>
    )
  }
  return <small>sem medição</small>
}

export interface RecvBlockProps {
  block: DisplayBlock
  open: boolean
  q: string
  exact: boolean
  sameAs: string | null
  linked: boolean
  secrets: readonly ContextSecretMask[]
  onToggle: (id: string) => void
  onCopy: (b: DisplayBlock) => void
  onOpenChat: () => void
}

export function RecvBlock({ block: b, open, q, exact, sameAs, linked, secrets, onToggle, onCopy, onOpenChat }: RecvBlockProps): JSX.Element {
  const hits = countHits(b.text, q)
  const miss = b.text === undefined
  const show = open || hits > 0
  return (
    <div className={`cm-blk${show ? ' open' : ''}${miss ? ' miss' : ''}${linked ? ' linked' : ''}`} data-id={b.id}>
      <button type="button" className="cm-blk-h" aria-expanded={show} onClick={() => onToggle(b.id)}>
        <span className="cm-tick" style={miss ? undefined : ({ background: TONE_COLOR[b.tone] } as CSSProperties)} />
        <Icon name={b.icon} />
        <span className="cm-blk-main">
          <span className="cm-blk-t">
            {b.title}
            {b.when !== undefined && <span className="cm-tg2 new">{clockOf(b.when)}</span>}
            {b.same && sameAs && <span className="cm-tg2">igual às {sameAs}</span>}
            {hits > 0 && <span className="cm-tg2 hits">{hits}</span>}
          </span>
          <span className="cm-blk-d">{b.desc}</span>
        </span>
        <span className="cm-blk-z">{sizeLabel(b, exact)}</span>
        <Icon name="chevron" className="cm-chev" />
      </button>
      {show &&
        (miss ? (
          <div className="cm-miss-note">
            {b.note}
            {b.list && b.list.length > 0 && (
              <ul className="cm-mlist">
                {b.list.map(([name, tokens]) => (
                  <li key={name}>
                    <span>{name}</span>
                    <b>{fmtTokens(tokens, exact)}</b>
                  </li>
                ))}
              </ul>
            )}
            {b.tone === 'link' && (
              <button type="button" className="cm-btn" onClick={onOpenChat}>
                <Icon name="msg" />
                Abrir o Chat
              </button>
            )}
          </div>
        ) : (
          <div className="cm-raw">
            <div className="cm-raw-h">
              {b.tone === 'sys' && secrets.length > 0 ? (
                <>
                  <Icon name="lock" />
                  Senhas aparecem mascaradas; o olho mostra o valor de agora por 30 s.
                </>
              ) : b.added && b.added.length > 0 ? (
                'Marcado em verde: o que mudou desde o envio anterior.'
              ) : (
                'Texto exato que o app enviou.'
              )}
              <span className="cm-grow" />
              <button type="button" className="cm-btn" onClick={() => onCopy(b)}>
                <Icon name="copy" />
                Copiar
              </button>
            </div>
            <RawText text={b.text!} q={q} added={b.added} secrets={secrets} />
          </div>
        ))}
    </div>
  )
}

/** O raio-X: a ordem em que o Agent lê, com a altura proporcional ao tamanho de cada parte. */
export function XRay({ blocks, q, lit, onOpen }: { blocks: readonly DisplayBlock[]; q: string; lit: string | null; onOpen: (id: string) => void }): JSX.Element {
  return (
    <div className="cm-xray" role="list" aria-label="Raio-X: a ordem em que o Agent lê e o tamanho de cada parte">
      <span className="cm-cap top">início</span>
      {blocks.map((b) => {
        const miss = b.text === undefined
        return (
          <button
            key={b.id}
            type="button"
            role="listitem"
            className={`cm-seg${miss ? (b.tone === 'link' ? ' link' : ' miss') : ''}${countHits(b.text, q) ? ' hit' : ''}${lit === b.id ? ' lit' : ''}`}
            style={{ flexGrow: Math.max(b.tokens, 250), background: miss ? undefined : TONE_COLOR[b.tone] } as CSSProperties}
            title={`${b.title} · ${b.text !== undefined ? `${kb(b.bytes)} · ~${fmtTokens(b.tokens)} tokens` : b.measured ? `${fmtTokens(b.tokens)} tokens, medido pelo SDK` : 'o app não vê'}`}
            aria-label={b.title}
            onClick={() => onOpen(b.id)}
          />
        )
      })}
      <span className="cm-cap bot">agora</span>
    </div>
  )
}

/** Para copiar um bloco: o texto sem as senhas. */
export function copyText(b: DisplayBlock): string {
  return maskedText(b.text ?? '')
}
