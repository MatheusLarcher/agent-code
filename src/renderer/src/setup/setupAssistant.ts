/**
 * Canal entre uma tela de configuração e o App: "peça ao agente para fazer isto".
 *
 * A tela chama `requestSetupTask(task)`; o App, que sabe abrir um chat de
 * sandbox e despachar a mensagem, escuta com `useSetupAssistant`. Um evento do
 * `window` evita passar um callback por todas as camadas do modal de Configurações.
 */
import { useEffect, useRef } from 'react'
import type { SetupTask } from '@shared/setupTasks'

const EVENT = 'agentcode:setup-task'

/** Pede ao App que abra um chat de sandbox com a tarefa. `false` = ninguém escutou. */
export function requestSetupTask(task: SetupTask): boolean {
  const event = new CustomEvent<SetupTask>(EVENT, { detail: task, cancelable: true })
  // Quem trata chama preventDefault: é assim que a tela sabe que o pedido foi aceito.
  return !window.dispatchEvent(event)
}

/** O App registra aqui quem executa a tarefa (abre o chat e manda o prompt). */
export function useSetupAssistant(run: (task: SetupTask) => void): void {
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const onTask = (event: Event): void => {
      const task = (event as CustomEvent<SetupTask>).detail
      if (!task || typeof task.prompt !== 'string' || typeof task.display !== 'string') return
      event.preventDefault()
      runRef.current(task)
    }
    window.addEventListener(EVENT, onTask)
    return () => window.removeEventListener(EVENT, onTask)
  }, [])
}
