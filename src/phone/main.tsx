import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/base.css'
import './styles/pair.css'
import './styles/shell.css'
import './styles/chat.css'
import './styles/composer.css'
import './styles/central.css'
import './styles/turn.css'
import './styles/settings.css'

createRoot(document.getElementById('root')!).render(<App />)
