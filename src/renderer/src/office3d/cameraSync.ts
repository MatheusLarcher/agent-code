/**
 * Copia a pose do CameraRig (números puros) para a PerspectiveCamera do three
 * e diz se a câmera mudou desde a última pergunta, comparando as matrizes —
 * sem alocar: o motor chama os dois a cada quadro.
 */
import { Matrix4, type PerspectiveCamera } from 'three'
import { cameraPosition, type CameraRig } from './cameraRig'

export class CameraSync {
  private readonly pos = { x: 0, y: 0, z: 0 }
  private readonly lastView = new Matrix4()
  private readonly lastProj = new Matrix4()

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly rig: CameraRig
  ) {}

  /** A câmera do three na pose atual do rig. */
  sync(): void {
    const pose = this.rig.pose
    const p = cameraPosition(pose, this.pos)
    this.camera.position.set(p.x, p.y, p.z)
    this.camera.lookAt(pose.tx, pose.ty, pose.tz)
    this.camera.updateMatrixWorld()
  }

  /** A câmera mudou desde a última chamada? (o culling/LOD só é refeito quando sim) */
  moved(): boolean {
    const c = this.camera
    if (c.matrixWorld.equals(this.lastView) && c.projectionMatrix.equals(this.lastProj)) return false
    this.lastView.copy(c.matrixWorld)
    this.lastProj.copy(c.projectionMatrix)
    return true
  }
}
