/**
 * O botão direito num arquivo da tela do VS Code do agente (CodeMonitor): as
 * abas, o Explorador, "Todos os arquivos" e os cartões de arquivo do Chat —
 * todo elemento com `data-path` (o caminho absoluto). O menu:
 *
 *   Abrir arquivo           no programa padrão do sistema
 *   Abrir pasta do arquivo  o Explorador com o arquivo selecionado
 *
 * Os dois pelo window.api.revealFile, que o main valida (só dentro do projeto
 * da conversa; arquivo apagado volta `missing` e vira aviso na tela). Fecha
 * com Esc (sem fechar a tela), clique fora, a roda do mouse ou a janela
 * perdendo o foco — como o ReplyMenu da Central. Sem o revealFile (o celular, pela ponte)
 * não há menu: o botão direito segue como sempre.
 *
 * O menu vai para o <body> (portal): a tela tem `container: size`, que prende
 * o `position: fixed` dela.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RevealFileMode } from '@shared/ipc'
import { Icon } from './icons'
import type { MonitorToast } from './useMonitorToasts'
import './fileMenu.css'

interface MenuAt {
  x: number
  y: number
  path: string
}

const MENU_W = 230
const MENU_H = 86
const nameOf = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p

export interface FileContextMenu {
  /** O botão direito na raiz da tela; ausente sem o revealFile (celular). */
  onContextMenu?: (e: MouseEvent) => void
  menu: JSX.Element | null
}

export function useFileContextMenu(cwd: string, toast: (t: MonitorToast) => void): FileContextMenu {
  const [at, setAt] = useState<MenuAt | null>(null)
  const close = useCallback(() => setAt(null), [])
  const api = typeof window !== 'undefined' ? window.api : undefined
  const reveal = typeof api?.revealFile === 'function' ? api.revealFile : null

  const onContextMenu = useCallback((e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-path]')
    const path = el?.getAttribute('data-path')
    if (!path) return
    e.preventDefault()
    e.stopPropagation()
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 4))
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H - 4))
    setAt({ x, y, path })
  }, [])

  const run = async (mode: RevealFileMode, path: string): Promise<void> => {
    close()
    if (!reveal) return
    const name = nameOf(path)
    const res = await reveal({ mode, path, cwd }).catch(() => ({ ok: false, message: 'O app não respondeu.', missing: false }))
    if (res.ok) return
    toast({
      id: 'file-menu', kind: 'warn', icon: 'alert', app: 'code',
      title: res.missing ? `${name} não existe mais` : `Não deu para abrir ${name}`,
      body: res.missing ? 'O arquivo foi apagado ou movido: nada foi aberto.' : res.message
    })
  }

  return {
    onContextMenu: reveal ? onContextMenu : undefined,
    menu: at && reveal ? createPortal(<Menu at={at} onClose={close} onRun={(mode) => void run(mode, at.path)} />, document.body) : null
  }
}

function Menu({ at, onClose, onRun }: { at: MenuAt; onClose: () => void; onRun: (mode: RevealFileMode) => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    // Esc na captura: fecha o menu antes de a tela (o motor) ver a tecla.
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    const down = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const away = (): void => onClose()
    window.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', down, true)
    // A roda (a rolagem do usuário): o `scroll` dispara também quando o editor segue o Agent sozinho.
    window.addEventListener('wheel', away, { passive: true })
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    return () => {
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('wheel', away)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="cm-filemenu"
      role="menu"
      aria-label={`Arquivo ${nameOf(at.path)}`}
      data-testid="file-menu"
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => onRun('open')} title="Abrir no programa padrão do Windows">
        <Icon name="file" />
        Abrir arquivo
      </button>
      <button type="button" role="menuitem" onClick={() => onRun('folder')} title="Abrir o Explorador na pasta, com o arquivo selecionado">
        <Icon name="folder" />
        Abrir pasta do arquivo
      </button>
    </div>
  )
}
