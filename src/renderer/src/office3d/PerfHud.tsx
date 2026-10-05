/**
 * HUD de desempenho do Escritório 3D — só em DEV (Ctrl+Alt+Shift+P): fps,
 * draw calls e triângulos (renderer.info.render do último quadro), salas à
 * vista, nível de LOD, pixelRatio e quantas vezes o shadow map foi refeito.
 * Lê o motor PERF_HUD_MS a PERF_HUD_MS enquanto está aberto; fechado, nada roda
 * (nem obriga o laço a renderizar).
 */
import { useEffect, useState } from 'react'
import { avatarPreview } from './agentModels'
import type { EngineStats } from './engine'

export const PERF_HUD_MS = 250
const LOD_NAMES = ['perto', 'médio', 'longe'] as const

/** Atalho de DEV: Ctrl+Alt+Shift+P. */
export function isPerfShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'p'
}

export interface PerfSource {
  readonly stats: EngineStats
  readonly running: boolean
}

type Snap = (EngineStats & { running: boolean }) | null

const take = (src: PerfSource | null): Snap => (src ? { ...src.stats, running: src.running } : null)

const thousands = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function PerfHud({ source }: { source: () => PerfSource | null }): JSX.Element {
  const [s, setS] = useState<Snap>(() => take(source()))
  useEffect(() => {
    const id = setInterval(() => setS(take(source())), PERF_HUD_MS)
    return () => clearInterval(id)
  }, [source])
  return (
    <div className="o3d-perf" data-testid="o3d-perf">
      {s ? (
        <>
          <div>
            <b>{s.running ? s.fps : 0}</b> fps{s.running ? '' : ' · parado'}
          </div>
          <div>
            <b>{s.calls}</b> draw calls · <b>{thousands(s.triangles)}</b> triângulos
          </div>
          <div>
            zonas {s.rooms}/{s.roomsTotal} · LOD {LOD_NAMES[s.lod]} · pixelRatio {s.pixelRatio.toFixed(2)}
          </div>
          <div>sombra refeita {s.shadowUpdates}×</div>
          <div>
            quadro {s.frameMs.toFixed(1)} ms (P95 {s.frameP95.toFixed(1)}) · JS {s.workMs.toFixed(1)} ms (P95 {s.workP95.toFixed(1)})
          </div>
          <div>agentes: {avatarPreview() ? 'avatar v1 (teste)' : 'boneco'} · Ctrl+Alt+Shift+V</div>
        </>
      ) : (
        <div>sem motor 3D</div>
      )}
    </div>
  )
}
