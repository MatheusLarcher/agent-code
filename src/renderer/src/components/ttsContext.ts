/**
 * O TTS do App ("Ouvir" e "Ler daqui") para quem não o recebe por prop: o App
 * põe em volta do Escritório o MESMO `tts` do chat (o áudio e o "Parar" são os
 * de lá), e o Chat da tela do monitor (codeScreen/ChatDock, MonitorChat) o lê
 * daqui. A prévia do hover não o lê: continua só leitura. Sem provider, null —
 * sem "Ouvir".
 */
import { createContext } from 'react'
import type { TtsControls } from './ChatRows'

export const TtsContext = createContext<TtsControls | null>(null)
