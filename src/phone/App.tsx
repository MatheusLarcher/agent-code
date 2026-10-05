/** Raiz do app do celular: a tela da vez (parear, reconectando, outro celular, app) e os avisos. */
import { useEffect } from 'react'
import { client, toasts } from './app/runtime'
import { useStore } from './core/store'
import { BlockedScreen, PairingScreen, PairScreen } from './pairing/ConnectScreens'
import { Shell } from './shell/Shell'
import { useViewport } from './shell/useViewport'

let started = false

function Toasts(): JSX.Element | null {
  const list = useStore(toasts, (s) => s.list)
  if (!list.length) return null
  return (
    <div className="toasts" role="status">
      {list.map((t) => (
        <div key={t.id} className="toast">{t.text}</div>
      ))}
    </div>
  )
}

export function App(): JSX.Element {
  const screen = useStore(client.store, (s) => s.screen)
  useViewport()
  useEffect(() => {
    // Uma vez por carga da página (o StrictMode/HMR não pode abrir duas conexões).
    if (started) return
    started = true
    client.start()
  }, [])
  return (
    <div className="app">
      {screen === 'pair' && <PairScreen />}
      {screen === 'pairing' && <PairingScreen />}
      {screen === 'blocked' && <BlockedScreen />}
      {screen === 'main' && <Shell />}
      {screen === 'boot' && <div className="boot"><span className="spinner" /></div>}
      <Toasts />
    </div>
  )
}
