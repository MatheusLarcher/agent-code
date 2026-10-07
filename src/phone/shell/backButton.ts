/**
 * O botão voltar do Android: um passo por toque, numa pilha que cada tela monta
 * registrando o seu "voltar" (`useBackHandler`). Quem tem a maior prioridade
 * (empate: o registro mais recente — o que abriu por último está por cima) e
 * aceita o toque o consome; ninguém aceitando, é a raiz da aba: o app MINIMIZA
 * (`App.minimizeApp`), nunca encerra.
 *
 * No APK o plugin oficial @capacitor/app (smartfone-remote/package.json) entrega
 * o `backButton` pela ponte nativa injetada (window.Capacitor), sem @capacitor/core
 * no bundle, como o voice/localStt.ts. Ouvir esse evento desliga o voltar padrão do
 * Android — daí todo caso, inclusive a raiz, ser tratado aqui. No navegador não há
 * ponte e nada muda.
 *
 * O pedido de permissão/pergunta pendente não registra "voltar": o toque nunca o
 * responde nem o descarta.
 */
import { useEffect, useRef } from 'react'

/** Prioridades da pilha (maior primeiro). Telas novas usam estas faixas. */
export const BACK = {
  /** Folha/modal/menu aberto por cima da tela (Configurações, menu de status, leitor de QR, menus). */
  modal: 300,
  /** Algo focado dentro da tela (tela do monitor no Escritório, faixa do agente). */
  focus: 200,
  /** Subtela de uma aba (chat → lista de conversas; plano → lista de planos). */
  screen: 100
} as const

/** Devolve `false` quando não havia nada a fazer (o toque passa para o próximo da pilha). */
export type BackHandler = () => boolean | void

interface Entry {
  priority: number
  seq: number
  fn: BackHandler
}

const PLUGIN = 'App'
const entries = new Set<Entry>()
let seq = 0
let installed = false

/** Registra um "voltar"; devolve a função que o tira da pilha. */
export function registerBack(priority: number, fn: BackHandler): () => void {
  const entry: Entry = { priority, seq: ++seq, fn }
  entries.add(entry)
  return () => {
    entries.delete(entry)
  }
}

/** Um passo do voltar. `false`: ninguém aceitou (raiz da aba). */
export function handleBack(): boolean {
  const list = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq)
  for (const e of list) if (e.fn() !== false) return true
  return false
}

/**
 * Enquanto `enabled`, a tela responde ao voltar com `fn` (lida na hora do toque:
 * não precisa ser estável). Entra no topo da sua faixa ao ser habilitada.
 */
export function useBackHandler(priority: number, fn: BackHandler, enabled = true): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    return registerBack(priority, () => ref.current())
  }, [priority, enabled])
}

/** Dentro do APK com o @capacitor/app compilado. */
export function backButtonAvailable(): boolean {
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined
  if (!cap || typeof cap.addListener !== 'function' || typeof cap.nativePromise !== 'function') return false
  return (cap.PluginHeaders ?? []).some((h) => h?.name === PLUGIN)
}

/** Raiz da aba: o app vai para o fundo (a conexão volta sozinha ao reabrir). */
function minimize(): void {
  void window.Capacitor?.nativePromise?.(PLUGIN, 'minimizeApp').catch(() => undefined)
}

/** Liga o voltar ao app (uma vez por carga; sem a ponte nativa, nada acontece). */
export function installBackButton(): void {
  if (installed || !backButtonAvailable()) return
  installed = true
  window.Capacitor!.addListener!(PLUGIN, 'backButton', (_data, err) => {
    if (err) return // resposta de erro da ponte, não um toque
    if (!handleBack()) minimize()
  })
}
