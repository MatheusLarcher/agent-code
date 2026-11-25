import { useEffect, useRef } from 'react'
import type { SuporteStatus } from '@shared/suporteRemoto'
import { useUI } from '../ui/UiProvider'
import { useSuporteRemoto } from './useSuporteRemoto'

/**
 * Os avisos do suporte remoto em toast, um por acontecimento, em qualquer tela do app:
 * conectou, o cliente recusou, o cliente encerrou, a sessão caiu. Não desenha nada.
 */
export function SuporteRemotoAvisos(): null {
  const { notify } = useUI()
  const { status, pronto } = useSuporteRemoto()
  const anterior = useRef<SuporteStatus | null>(null)

  useEffect(() => {
    const antes = anterior.current
    anterior.current = pronto ? status : null
    // O estado de quando a tela abriu (uma queda antiga, por exemplo) não é novidade.
    if (!pronto || !antes) return
    if (status.estado === 'conectado' && antes.estado !== 'conectado') {
      notify('sucesso', `Conectado ao computador ${status.pc || 'do cliente'}.`)
      return
    }
    const aviso = status.aviso
    if (!aviso || aviso.n === antes.aviso?.n) return
    if (aviso.tipo === 'recusado' || aviso.tipo === 'encerrado') notify('aviso', aviso.texto)
    else if (aviso.tipo === 'caiu') notify('erro', aviso.texto)
    // 'erro' (chave, código, rede): quem pediu a conexão já mostra — a faixa ou o agente no chat.
  }, [status, pronto, notify])

  return null
}
