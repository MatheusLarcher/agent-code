/**
 * O app segue o viewport VISUAL: no WebView ≥ M139 o teclado encolhe só ele
 * (edge-to-edge do Android 15+ não redimensiona a janela), e em versões antigas a
 * janela inteira encolhe (adjustResize). Nos dois casos `--app-h` acompanha, e o
 * composer fica logo acima do teclado. "Teclado aberto" = encolheu bem e há um
 * campo de texto em foco — é quando a barra de abas some para não comer o composer.
 */
import { useEffect } from 'react'
import { createStore } from '../core/store'

export const viewport = createStore<{ keyboard: boolean }>({ keyboard: false })

const KEYBOARD_MIN_PX = 120

function textFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const t = (el as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes(t)
}

export function useViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport
    const root = document.documentElement
    let full = { w: window.innerWidth, h: Math.max(window.innerHeight, vv?.height ?? 0) }
    const update = (): void => {
      const h = vv ? vv.height : window.innerHeight
      const w = window.innerWidth
      // Girou a tela (largura mudou): a altura "cheia" é outra.
      if (Math.abs(w - full.w) > 40) full = { w, h: Math.max(window.innerHeight, h) }
      else full.h = Math.max(full.h, window.innerHeight, h)
      root.style.setProperty('--app-h', `${Math.round(h)}px`)
      root.style.setProperty('--app-top', `${Math.round(vv?.offsetTop ?? 0)}px`)
      viewport.set({ keyboard: full.h - h > KEYBOARD_MIN_PX && textFocused() })
    }
    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', update)
    // O teclado fecha um instante depois do blur: confere de novo em seguida.
    const onFocusOut = (): void => {
      update()
      setTimeout(update, 250)
    }
    document.addEventListener('focusout', onFocusOut)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
