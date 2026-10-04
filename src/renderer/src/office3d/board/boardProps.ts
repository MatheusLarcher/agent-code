/**
 * As peças fixas do kanban de uma sala (three), em coordenadas locais do
 * quadro: moldura e canaleta (UMA malha instanciada — uma chamada de desenho),
 * o fundo atrás da face, o bloquinho na canaleta (de onde sai o papel novo) e o
 * cesto no chão (para onde vai o que sai do quadro). Bloquinho e cesto ficam
 * em `props` (a vista os esconde no LONGE).
 */
import { Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type MeshLambertMaterial } from 'three'
import type { BoardPlace } from '../furniture'
import type { Kit } from '../kit'
import type { BoardKit } from './boardKit'
import { BIN_SPOT, BOARD_H, BOARD_W, FACE_H, FACE_W } from './boardLayout'

export interface BoardProps {
  frame: InstancedMesh
  props: Group
  /** Topo do bloquinho e boca do cesto (locais): de onde o papel novo sai e para onde o que sai vai. */
  pad: { x: number; y: number; z: number }
  bin: { x: number; y: number; z: number }
}

export function buildBoardProps(kit: Kit, bk: BoardKit, root: Group, spot: BoardPlace): BoardProps {
  const box = (mat: MeshLambertMaterial, w: number, h: number, d: number, x: number, y: number, z: number, into: Group): Mesh => {
    const m = new Mesh(kit.geo.box, mat)
    m.scale.set(w, h, d)
    m.position.set(x, y, z)
    m.receiveShadow = true
    into.add(m)
    return m
  }
  const fr = (BOARD_W - FACE_W) / 2
  const bars: Array<[number, number, number, number, number, number]> = [
    [BOARD_W, fr, 0.05, 0, FACE_H / 2 + fr / 2, 0.09],
    [BOARD_W, fr, 0.05, 0, -FACE_H / 2 - fr / 2, 0.09],
    [fr, FACE_H, 0.05, -FACE_W / 2 - fr / 2, 0, 0.09],
    [fr, FACE_H, 0.05, FACE_W / 2 + fr / 2, 0, 0.09],
    [BOARD_W - 0.1, 0.025, 0.13, 0, -BOARD_H / 2 - 0.0125, 0.135]
  ]
  const frame = new InstancedMesh(kit.geo.box, kit.mat.corkFrame, bars.length)
  const m4 = new Matrix4()
  const q = new Quaternion()
  bars.forEach(([w, h, d, x, y, z], i) => frame.setMatrixAt(i, m4.compose(new Vector3(x, y, z), q, new Vector3(w, h, d))))
  frame.computeBoundingSphere()
  frame.receiveShadow = true
  root.add(frame)
  box(bk.mat.backing, FACE_W, FACE_H, 0.046, 0, 0, 0.085, root)

  const props = new Group()
  root.add(props)
  const pad = { x: spot.pad.x - spot.x, y: spot.pad.y - spot.y + 0.02, z: spot.pad.z - spot.z }
  box(kit.mat.note, 0.16, 0.022, 0.11, pad.x, pad.y - 0.006, pad.z, props)
  box(bk.mat.padTop, 0.16, 0.004, 0.11, pad.x, pad.y + 0.007, pad.z, props)
  const can = new Mesh(kit.geo.cyl, bk.mat.bin)
  can.scale.set(BIN_SPOT.r * 2, BIN_SPOT.h, BIN_SPOT.r * 2)
  can.position.set(spot.bin.x - spot.x, BIN_SPOT.h / 2 - spot.y, spot.bin.z - spot.z)
  can.castShadow = true
  can.receiveShadow = true
  const ball = new Mesh(kit.geo.leaf, kit.mat.note)
  ball.scale.setScalar(0.09)
  ball.position.set(can.position.x + 0.03, BIN_SPOT.h - spot.y + 0.01, can.position.z)
  props.add(can, ball)
  return { frame, props, pad, bin: { x: can.position.x, y: BIN_SPOT.h - spot.y + 0.02, z: can.position.z } }
}
