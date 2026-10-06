"""Corrige a ponta da cabeça (head_end/HeadTop_End) de um avatar quando o rig a pôs fora do lugar.

Uso: python fix_head_end.py entrada.glb saida.glb [fração=0.85]

O app alinha a cabeça mirando a junta Head → ponta da cabeça para cima (agentRest.ts) e mede a
altura da cabeça por ela. O auto-rig do Meshy às vezes deixa a ponta quase colada na junta Head
e para a frente (o subagente: +0,8 cm de altura): a cabeça giraria ~75° para trás. Aqui a ponta
vai para cima da junta Head, a `fração` da distância até o alto da malha (no bind), no espaço
local do Head. O Meshy prende parte do cabelo no osso de ponta: a matriz inversa de bind dele é
refeita junto (IBM' = mundo_novo⁻¹ · mundo_velho · IBM), e a malha fica onde estava.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compress_glb import read_glb, write_glb  # noqa: E402
from inspect_glb import trs  # noqa: E402
from rig_markers import mesh_box  # noqa: E402


def main():
    src, dst = sys.argv[1], sys.argv[2]
    frac = float(sys.argv[3]) if len(sys.argv) > 3 else 0.85
    g, binb = read_glb(src)
    nodes = g["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def wm(i):
        return (wm(parent[i]) if i in parent else np.eye(4)) @ trs(nodes[i])

    idx = {(n.get("name") or "").lower(): i for i, n in enumerate(nodes)}
    head = idx.get("head")
    end = idx.get("head_end", idx.get("headtop_end"))
    if head is None or end is None or parent.get(end) != head:
        sys.exit("sem Head → head_end (filho direto) no esqueleto")
    hw = wm(head)
    top = mesh_box(g, binb)[1][1]
    hy = hw[1, 3]
    want = np.array([hw[0, 3], hy + frac * (top - hy), hw[2, 3], 1.0])
    local = np.linalg.inv(hw) @ want
    old = np.array(nodes[end].get("translation", [0, 0, 0]))
    w_old = wm(end)
    nodes[end].pop("matrix", None)
    nodes[end]["translation"] = [float(v) for v in local[:3]]
    w_new = wm(end)
    # A pele presa no osso de ponta não pode andar com ele: refaz a matriz inversa de bind dele em cada skin.
    out = bytearray(binb)
    fixed = 0
    for sk in g.get("skins", []):
        if end not in sk["joints"] or "inverseBindMatrices" not in sk:
            continue
        acc = g["accessors"][sk["inverseBindMatrices"]]
        bv = g["bufferViews"][acc["bufferView"]]
        at = bv.get("byteOffset", 0) + acc.get("byteOffset", 0) + sk["joints"].index(end) * 64
        ibm = np.frombuffer(bytes(out[at: at + 64]), "<f4").reshape(4, 4).T.astype(np.float64)
        ibm_new = np.linalg.inv(w_new) @ w_old @ ibm
        out[at: at + 64] = ibm_new.T.astype("<f4").tobytes()
        fixed += 1
    write_glb(dst, g, bytes(out))
    print(f"ok: {dst} | ponta da cabeça {old.round(4)} → {np.round(local[:3], 4)} (local do Head) | {frac:.2f} da altura até o topo ({top - hy:.3f} m) | matrizes de bind refeitas: {fixed}")


if __name__ == "__main__":
    main()
