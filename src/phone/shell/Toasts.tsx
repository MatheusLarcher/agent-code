/** Os avisos curtos (toasts): empilhados, com a cor do tipo, fecham no toque e somem sozinhos com fade-out. */
import { dismissToast, nav, toasts } from '../app/runtime'
import { useStore } from '../core/store'

export function Toasts(): JSX.Element | null {
  const list = useStore(toasts, (s) => s.list)
  // Com o leitor de QR aberto os avisos sobem um pouco: a dica e o "Cancelar" do leitor ficam livres.
  const scanning = useStore(nav, (s) => s.scanOpen)
  if (!list.length) return null
  return (
    <div className={`toasts${scanning ? ' over-scanner' : ''}`} role="status">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast${t.tipo ? ' ' + t.tipo : ''}${t.leaving ? ' leaving' : ''}`}
          role={t.tipo === 'erro' ? 'alert' : undefined}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
