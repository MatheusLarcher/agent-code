import { useState, type ReactNode } from 'react'
import type { SettingsTab } from '../../ui/SettingsModal'
import './primeirosPassos.css'

/**
 * Apresentação inicial na conversa vazia (27/11): passa pelos módulos das Configurações
 * (conta e modelo, memórias, dados/OneDrive, ajudantes e voz) e termina no 1º pedido — o
 * objetivo combinado com o Erick. Cada passo abre a aba certa e ganha ✓ quando visitado.
 * Some depois do 1º pedido ou do "pular"; as marcas ficam neste computador.
 */
export const PRIMEIROS_PASSOS_CHAVE = 'agentcode.primeirosPassos'
const VISTOS_CHAVE = 'agentcode.primeirosPassos.vistos'

export const EXEMPLOS = [
  'Crie uma página com um botão que mostra a hora atual',
  'Monte uma planilha de gastos do mês com o total por categoria',
  'Explique, em palavras simples, o que tem nesta pasta'
] as const

type Modulo = 'conta' | 'memorias' | 'dados' | 'ajudantes'

/** Já concluiu (mandou o 1º pedido ou pulou)? Sem acesso ao armazenamento, mostra de novo. */
export function primeirosPassosFeito(): boolean {
  try {
    return localStorage.getItem(PRIMEIROS_PASSOS_CHAVE) === 'feito'
  } catch {
    return false
  }
}

export function marcarPrimeirosPassos(): void {
  try {
    localStorage.setItem(PRIMEIROS_PASSOS_CHAVE, 'feito')
  } catch {
    /* sem armazenamento: aparece de novo na próxima conversa vazia, sem prejuízo */
  }
}

function lerVistos(): Set<Modulo> {
  try {
    const v = JSON.parse(localStorage.getItem(VISTOS_CHAVE) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? (v as Modulo[]) : [])
  } catch {
    return new Set()
  }
}

interface Props {
  /** O cartão "Conectar conta" quando a conta ainda não está ligada; null = conectada. */
  conectarConta: ReactNode | null
  /** Põe o texto na caixa de mensagem (não envia). */
  onExemplo(texto: string): void
  onPular(): void
  /** Abre as Configurações na aba do módulo. Sem ele, os botões não aparecem. */
  onAbrirConfiguracoes?: (aba: SettingsTab) => void
}

interface Passo {
  id: Modulo
  titulo: string
  texto: ReactNode
  botoes: Array<{ rotulo: string; aba: SettingsTab }>
}

const PASSOS: Passo[] = [
  {
    id: 'memorias',
    titulo: 'Memórias',
    texto: 'O memorista anota sozinho o que você ensina, e o bibliotecário organiza tudo por assunto. Comece com o bibliotecário só mostrando o que faria.',
    botoes: [{ rotulo: 'Ajustar memórias', aba: 'geral' }]
  },
  {
    id: 'dados',
    titulo: 'Seus dados em qualquer computador',
    texto: 'Aponte a pasta de dados para o OneDrive: memórias e skills vão junto para qualquer computador em que você usar o Agent Code.',
    botoes: [{ rotulo: 'Escolher a pasta', aba: 'dados' }]
  },
  {
    id: 'ajudantes',
    titulo: 'Ajudantes e voz',
    texto: 'O PO, o vigia e o Scrum Master acompanham o trabalho em paralelo. Com a voz, você fala o pedido e ouve a resposta.',
    botoes: [
      { rotulo: 'Ajustar ajudantes', aba: 'geral' },
      { rotulo: 'Ligar a voz', aba: 'voz' }
    ]
  }
]

export function PrimeirosPassos({ conectarConta, onExemplo, onPular, onAbrirConfiguracoes }: Props): JSX.Element {
  const conectada = !conectarConta
  const [vistos, setVistos] = useState<Set<Modulo>>(lerVistos)
  const abrir = (id: Modulo, aba: SettingsTab): void => {
    const next = new Set(vistos).add(id)
    setVistos(next)
    try {
      localStorage.setItem(VISTOS_CHAVE, JSON.stringify([...next]))
    } catch {
      /* só a marca de visto se perde */
    }
    onAbrirConfiguracoes?.(aba)
  }
  const classe = (feito: boolean, atual = false): string => `pp-passo${feito ? ' feito' : atual ? ' atual' : ''}`
  const total = PASSOS.length + 2

  return (
    <section className="pp" aria-labelledby="pp-titulo">
      <header className="pp-cabeca">
        <span className="pp-estrela" aria-hidden="true">✦</span>
        <div>
          <h2 id="pp-titulo">Primeiros passos</h2>
          <p>Deixe o Agent Code do seu jeito e faça o primeiro pedido. Cada passo abre a parte certa das Configurações.</p>
        </div>
      </header>

      <ol className="pp-passos">
        <li className={classe(conectada, true)}>
          <span className="pp-marca" aria-hidden="true">{conectada ? '✓' : '1'}</span>
          <div className="pp-corpo">
            <h3>Conta e modelo</h3>
            {conectada ? (
              <p>Conta conectada. Escolha o modelo e o esforço que vêm marcados em cada conversa nova.</p>
            ) : (
              <>
                <p>Sem a conta do Claude, o agente não consegue responder.</p>
                {conectarConta}
              </>
            )}
            {onAbrirConfiguracoes && (
              <div className="pp-acoes">
                <button type="button" className="pp-acao" onClick={() => abrir('conta', 'modelos')}>Abrir Modelos e contas</button>
              </div>
            )}
          </div>
        </li>

        {PASSOS.map((p, i) => (
          <li key={p.id} className={classe(vistos.has(p.id))}>
            <span className="pp-marca" aria-hidden="true">{vistos.has(p.id) ? '✓' : i + 2}</span>
            <div className="pp-corpo">
              <h3>{p.titulo}</h3>
              <p>{p.texto}</p>
              {onAbrirConfiguracoes && (
                <div className="pp-acoes">
                  {p.botoes.map((b) => (
                    <button key={b.rotulo} type="button" className="pp-acao" onClick={() => abrir(p.id, b.aba)}>{b.rotulo}</button>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}

        <li className={classe(false, conectada)}>
          <span className="pp-marca" aria-hidden="true">{total}</span>
          <div className="pp-corpo">
            <h3>Faça o primeiro pedido</h3>
            <p>
              Esta conversa trabalha no <strong>Sandbox</strong>, uma pasta de testes: nada do seu computador é mexido.
              Escolha um exemplo, leia na caixa de mensagem, ajuste se quiser e aperte Enter.
            </p>
            <div className="pp-exemplos">
              {EXEMPLOS.map((texto) => (
                <button key={texto} type="button" className="pp-exemplo" disabled={!conectada} onClick={() => onExemplo(texto)}>
                  {texto}
                </button>
              ))}
            </div>
          </div>
        </li>
      </ol>

      <button type="button" className="pp-pular" onClick={onPular}>
        Já sei usar, pular
      </button>
    </section>
  )
}
