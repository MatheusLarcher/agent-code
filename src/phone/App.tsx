/** Raiz do app do celular: a tela da vez (parear, reconectando, outro celular, app), o leitor de QR e os avisos. */
import { useEffect } from 'react'
import { client } from './app/runtime'
import { useStore } from './core/store'
import { BlockedScreen, PairingScreen, PairScreen } from './pairing/ConnectScreens'
import { FilialScanner } from './pairing/FilialScanner'
import { Shell } from './shell/Shell'
import { Toasts } from './shell/Toasts'
import { useViewport } from './shell/useViewport'

let started = false

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
      {/* O leitor de QR de "Abrir filial" sobe por cima de qualquer tela; os avisos, por cima do leitor. */}
      <FilialScanner />
      <Toasts />
    </div>
  )
}
