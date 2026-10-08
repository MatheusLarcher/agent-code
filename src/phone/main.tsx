import { createRoot } from 'react-dom/client'
import { HoverTipLayer } from '@renderer/components/HoverTip'
import { App } from './App'
import './styles/base.css'
import './styles/pair.css'
import './styles/shell.css'
import './styles/chat.css'
import './styles/composer.css'
import './styles/central.css'
import './styles/turn.css'
import './styles/settings.css'

// O tooltip do app (toque longo no celular) no lugar do `title` nativo.
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <HoverTipLayer />
  </>
)
