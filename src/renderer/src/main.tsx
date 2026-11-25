import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { HoverTipLayer } from './components/HoverTip'
import { UiProvider } from './ui/UiProvider'
import { SuporteRemotoAvisos } from './suporte/SuporteRemotoAvisos'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UiProvider>
      <App />
      {/* Suporte remoto: conectou, o cliente recusou, a sessão caiu. */}
      <SuporteRemotoAvisos />
    </UiProvider>
    {/* O tooltip do app inteiro no lugar do `title` nativo. */}
    <HoverTipLayer />
  </React.StrictMode>
)
