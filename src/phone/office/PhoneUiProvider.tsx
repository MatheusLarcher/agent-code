/**
 * O `UiContext` do renderer do PC, fornecido pelo celular em volta da aba
 * Escritório: os componentes do PC que ela monta (ToolCard, "Baixar" do chat,
 * "Comentar", TvDeploy…) chamam `useUI()` e, sem provider, lançam — o React
 * desmontava o app inteiro (tela preta). Aqui `notify` vira o aviso curto do
 * celular e `confirm`, uma folha simples de baixo para cima (a do pedido de
 * permissão). O clique no aviso (`opts.onClick`) não existe no celular.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { UiContext, type ConfirmOptions, type ToastType, type UiContextValue } from '@renderer/ui/UiProvider'
import { toast } from '../app/runtime'
import { BACK, useBackHandler } from '../shell/backButton'

type Pending = { opts: ConfirmOptions; resolve: (ok: boolean) => void }

export function PhoneUiProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null)
  const notify = useCallback((tipo: ToastType, msg: string): void => toast(msg, tipo), [])
  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise<boolean>((resolve) =>
        setPending((prev) => {
          prev?.resolve(false) // um pedido por vez: o anterior conta como cancelado
          return { opts, resolve }
        })
      ),
    []
  )
  const answer = useCallback((ok: boolean): void => {
    setPending((p) => {
      p?.resolve(ok)
      return null
    })
  }, [])
  const value = useMemo<UiContextValue>(() => ({ notify, confirm }), [notify, confirm])
  // Voltar com a folha aberta conta como "Cancelar".
  useBackHandler(BACK.modal, () => answer(false), !!pending)
  return (
    <UiContext.Provider value={value}>
      {children}
      {pending ? <ConfirmSheet opts={pending.opts} onAnswer={answer} /> : null}
    </UiContext.Provider>
  )
}

function ConfirmSheet({ opts, onAnswer }: { opts: ConfirmOptions; onAnswer: (ok: boolean) => void }): JSX.Element {
  return (
    <div className="modal-overlay" onClick={() => onAnswer(false)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={opts.title ?? 'Confirmar'} onClick={(e) => e.stopPropagation()}>
        <div className="perm-body">
          {opts.title ? <div className="perm-q-title">{opts.title}</div> : null}
          <div className="perm-desc">{opts.message}</div>
        </div>
        <div className="perm-actions">
          <button type="button" className="perm-btn-deny" onClick={() => onAnswer(false)}>
            {opts.cancelLabel ?? 'Cancelar'}
          </button>
          <button type="button" className={opts.danger ? 'ui-confirm-danger' : 'perm-btn-submit'} onClick={() => onAnswer(true)}>
            {opts.confirmLabel ?? 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}
