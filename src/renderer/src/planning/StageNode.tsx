/**
 * Cabeçalho de coluna no canvas: número e nome da etapa, com o status. A
 * coluna "Sem etapa" usa o mesmo nó, tracejado. Não se arrasta nem se apaga;
 * as alças existem só para a seta de sequência entre etapas.
 */
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PlanningStageStatus } from '@shared/ipc'
import { STAGE_STATUS_LABEL, StageStatusIcon } from './cardTypes'

export type StageNodeData = {
  titulo: string
  /** null = coluna "Sem etapa". */
  status: PlanningStageStatus | null
  /** Posição da etapa no roteiro (1-based). */
  ordem: number
  count: number
}
export type StageFlowNode = Node<StageNodeData, 'stage'>

function StageNodeView({ data }: NodeProps<StageFlowNode>): JSX.Element {
  const { titulo, status, ordem, count } = data
  return (
    <div className={`pl-stage${status ? ` ${status}` : ' sem-etapa'}`} title={titulo}>
      <Handle type="target" position={Position.Left} className="pl-handle-hidden" isConnectable={false} />
      <span className="pl-stage-num">{status ? String(ordem).padStart(2, '0') : '··'}</span>
      <span className="pl-stage-text">
        <span className="pl-stage-title">{titulo}</span>
        <span className="pl-stage-meta">
          {status && (
            <span className="pl-stage-status">
              <StageStatusIcon status={status} size={11} />
              {STAGE_STATUS_LABEL[status]}
            </span>
          )}
          <span className="pl-stage-count">
            {count} card{count === 1 ? '' : 's'}
          </span>
        </span>
      </span>
      <Handle type="source" position={Position.Right} className="pl-handle-hidden" isConnectable={false} />
    </div>
  )
}

export const StageNode = memo(StageNodeView)
