import { useState } from 'react'

interface ConversaArquivada {
  id: string
  title: string
  updatedAt: number
}

interface Props {
  conversations: ConversaArquivada[]
  onUnarchive: (id: string) => void
}

/**
 * As arquivadas num cartão de vidro. O `brightness` no `backdrop-filter` é o que
 * separa vidro de borrão: num tema escuro, blur sozinho devolve um cinza apagado —
 * clarear o que está atrás antes de embaçar é o que dá a sensação de vidro real.
 * O aro de 1px é um gradiente mascarado (dois retângulos, um recortando o outro),
 * porque `border` de cor chapada não acompanha a luz do fundo.
 */
export default function ArchivedCard({ conversations, onUnarchive }: Props): JSX.Element | null {
  const [aberto, setAberto] = useState(false)
  if (!conversations.length) return null

  return (
    <>
      <style>{css}</style>
      <section className={`arqc ${aberto ? 'aberto' : ''}`}>
        <button className="arqc-head" onClick={() => setAberto((v) => !v)} aria-expanded={aberto}>
          <svg className="arqc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="arqc-title">Arquivadas ({conversations.length})</span>
        </button>

        {/* 0fr → 1fr: é o único jeito de animar "altura automática" sem medir nada em JS. */}
        <div className="arqc-wrap">
          <div className="arqc-clip">
            <ul className="arqc-list">
              {conversations.map((c) => (
                <li className="arqc-item" key={c.id}>
                  <span className="arqc-item-title">{c.title}</span>
                  <button
                    className="arqc-unarchive"
                    title="Desarquivar"
                    onClick={() => onUnarchive(c.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="4" rx="1" />
                      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                      <polyline points="9 14 12 11 15 14" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </>
  )
}

const css = `
.arqc {
  position: relative;
  border-radius: var(--radius);
  font-family: var(--font);
  color: var(--text);
  background: color-mix(in srgb, var(--bg-2) 55%, transparent);
  backdrop-filter: brightness(1.6) saturate(1.25) blur(14px);
  -webkit-backdrop-filter: brightness(1.6) saturate(1.25) blur(14px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
/* aro cromático: gradiente preenchendo só a moldura de 1px */
.arqc::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg,
    color-mix(in srgb, var(--text) 55%, transparent),
    color-mix(in srgb, var(--accent) 45%, transparent) 45%,
    transparent 70%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.arqc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 13px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font: inherit;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  transition: color 160ms ease;
}
.arqc-head:hover { color: var(--text); }
.arqc-chevron { transition: transform 220ms cubic-bezier(0.2, 0.8, 0.3, 1); flex-shrink: 0; }
.arqc.aberto .arqc-chevron { transform: rotate(90deg); }
.arqc-title { font-weight: 500; }

.arqc-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 260ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.arqc.aberto .arqc-wrap { grid-template-rows: 1fr; }
.arqc-clip { overflow: hidden; }

.arqc-list { list-style: none; margin: 0; padding: 0 6px 6px; }
.arqc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  font-size: 13px;
  transition: background 160ms ease;
}
.arqc-item:hover { background: color-mix(in srgb, var(--bg-3) 70%, transparent); }
.arqc-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.arqc-item:hover .arqc-item-title { color: var(--text); }
/* acessório: ocupa o lugar desde sempre (não empurra nada ao aparecer) */
.arqc-unarchive {
  display: flex;
  background: transparent;
  border: none;
  padding: 2px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transform: translateX(3px);
  transition: opacity 160ms ease, transform 160ms ease, color 160ms ease;
}
.arqc-item:hover .arqc-unarchive { opacity: 1; transform: none; }
.arqc-unarchive:hover { color: var(--accent); }
`
