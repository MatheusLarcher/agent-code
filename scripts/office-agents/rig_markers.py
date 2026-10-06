"""Marcadores do auto-rig do Mixamo a partir do rig do Meshy do mesmo personagem.

Uso: python rig_markers.py <rig-meshy.glb> <modelo-meshy.glb> <saida.json> [escala=100]

O rig do Meshy (meshy_3d.py) traz as juntas no lugar certo: os marcadores do Mixamo
(queixo, pulsos, cotovelos, joelhos e virilha) saem delas, levados ao referencial da malha
SEM rig (a que vai no ZIP do glb_to_obj_zip.py) pela caixa das duas malhas — é a mesma malha,
só reescalada para a altura pedida no rig. `escala` é a do ZIP (100 = cm, o que o Mixamo lê).
Esquerda = a do personagem (+X com ele de frente para +Z), como no mixamo_rig.mjs.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inspect_glb import accessor, load, trs  # noqa: E402


def world_mats(g):
    nodes = g.get("nodes", [])
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    cache = {}

    def wm(i):
        if i not in cache:
            cache[i] = (wm(parent[i]) if i in parent else np.eye(4)) @ trs(nodes[i])
        return cache[i]

    return nodes, wm


def mesh_box(g, binb):
    """Caixa (mín, máx) das malhas no bind: com pele vale junta × matriz inversa de bind."""
    nodes, wm = world_mats(g)
    pts = []
    for ni, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        m = wm(ni)
        if "skin" in n:
            sk = g["skins"][n["skin"]]
            if "inverseBindMatrices" in sk:
                ibm = accessor(g, binb, sk["inverseBindMatrices"])[0].reshape(4, 4).T
                m = wm(sk["joints"][0]) @ ibm
        for p in g["meshes"][n["mesh"]]["primitives"]:
            pos = accessor(g, binb, p["attributes"]["POSITION"])
            pts.append((np.c_[pos, np.ones(len(pos))] @ m.T)[:, :3])
    allp = np.vstack(pts)
    return allp.min(0), allp.max(0)


def joints(g):
    nodes, wm = world_mats(g)
    out = {}
    for i, n in enumerate(nodes):
        name = (n.get("name") or "").lower()
        out[name] = wm(i)[:3, 3]
    return out


def main():
    rig_path, model_path, out_path = sys.argv[1:4]
    scale = float(sys.argv[4]) if len(sys.argv) > 4 else 100.0
    g, binb, _ = load(rig_path)
    rmin, rmax = mesh_box(g, binb)
    j = joints(g)
    gm, bm, _ = load(model_path)
    mmin, mmax = mesh_box(gm, bm)
    k = (mmax[1] - mmin[1]) / (rmax[1] - rmin[1])
    rc = (rmin + rmax) / 2
    mc = (mmin + mmax) / 2

    def to_model(p):
        return (np.asarray(p) - rc) * k + mc

    def get(*names):
        for n in names:
            if n in j:
                return j[n]
        raise SystemExit(f"junta não encontrada: {names}")

    height = rmax[1] - rmin[1]
    up_l, up_r = get("leftupleg"), get("rightupleg")
    head = get("head")
    marks = {
        # Queixo: um pouco acima da junta da cabeça (no Meshy ela fica na base do crânio, à altura da mandíbula).
        "chin": [0.0, head[1] + 0.012 * height, head[2]],
        "larm": get("lefthand"), "rarm": get("righthand"),
        "lelbow": get("leftforearm"), "relbow": get("rightforearm"),
        "lknee": get("leftleg"), "rknee": get("rightleg"),
        # Virilha: abaixo das juntas do quadril (~6,4% da altura, medido no v1).
        "groin": [0.0, (up_l[1] + up_r[1]) / 2 - 0.064 * height, (up_l[2] + up_r[2]) / 2],
    }
    res = {}
    for name, p in marks.items():
        q = to_model(p) * scale
        res[name] = {"x": round(float(q[0]), 4), "y": round(float(q[1]), 4), "z": round(float(q[2]), 4)}
    # Conferência: o pulso esquerdo do personagem tem de ficar em +X.
    if res["larm"]["x"] < res["rarm"]["x"]:
        print("aviso: pulso esquerdo em -X — o personagem não olha para +Z?")
    json.dump(res, open(out_path, "w"), indent=1)
    print(f"ok: {out_path} | malha do rig {height:.3f} m → modelo {mmax[1] - mmin[1]:.3f} (×{k:.3f}) | escala {scale}")
    for n, v in res.items():
        print(f"  {n:7s} x={v['x']:8.2f} y={v['y']:8.2f} z={v['z']:8.2f}")


if __name__ == "__main__":
    main()
