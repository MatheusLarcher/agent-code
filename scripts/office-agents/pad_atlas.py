"""Limpa o atlas de um GLB de agente: repinta os triângulos com cor de lixo e preenche o vão entre as ilhas UV.

Uso: python pad_atlas.py entrada.glb saida.glb [--textures origem-2k.glb]

O atlas do Meshy é picotado em centenas de ilhas, e a faixa em volta da textura (a
"moldura" serrilhada) vem pintada com pinceladas soltas de cabelo/pele. Parte dos
triângulos da roupa cai nessa faixa ou em ilhas minúsculas com a cor errada: calça
preta com riscos laranja e uma mancha riscada em volta do agente.

1. Triângulos destoantes: cada triângulo é comparado com os vizinhos NA MALHA (arestas
   compartilhadas, vértices soldados pela posição). É repintado, nas três texturas
   (cor, metal/rugosidade com a máscara de tingimento no R, normal), com a mediana
   dos vizinhos quando:
   - os vizinhos são roupa neutra (calça/sapato: escuros e pouco saturados) e ele é
     quente (fiapo de cabelo/pele), em qualquer lugar do atlas; ou
   - ele está na moldura do atlas e a cor dele foge da dos vizinhos.
   Olhos, boca e botões ficam: não estão cercados de roupa neutra nem na moldura.
2. Vão: cada texel FORA das ilhas recebe a média dos vizinhos já preenchidos, crescendo
   da borda para fora ("edge padding"), para o mipmap não misturar a pincelada solta.

Grava as texturas em PNG (sem perda): rode o compress_glb.py depois. Para um agente já
pronto (rig e nós ajustados), as texturas vêm da origem 2k do Meshy com --textures:
  pad_atlas.py resources/office-agents/<nome>.glb tmp.glb --textures out/elenco/<nome>/meshy-mask.glb
  compress_glb.py tmp.glb resources/office-agents/<nome>.glb

Requisitos: Python 3 + Pillow + numpy.
"""
import argparse
import io
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compress_glb import read_glb, write_glb  # noqa: E402
from inspect_glb import accessor  # noqa: E402

# Passos de crescimento do vão; o que sobrar (texel longe de tudo) recebe a cor média.
MAX_STEPS = 256
NEIGHBORS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
# Roupa neutra (vizinhança): saturação e valor (HSV, 0–1) da mediana dos vizinhos.
NEUTRAL_S = 0.22
NEUTRAL_V = 0.6
# Triângulo quente demais para uma vizinhança neutra: saturação mínima, R acima de G e B, distância RGB.
WARM_S = 0.12
WARM_GAP = 8
WARM_DIST = 20
# Moldura do atlas (fração do lado) e distância RGB a partir da qual a cor é lixo ali.
FRAME = 0.06
FRAME_DIST = 45
PASSES = 3


def mesh_triangles(gltf, binb):
    """UV e posição de cada triângulo do material 0 (posições soldadas para achar os vizinhos)."""
    uvs, keys = [], []
    weld = {}
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            if prim.get("material", 0) != 0 or "TEXCOORD_0" not in prim["attributes"]:
                continue
            uv = accessor(gltf, binb, prim["attributes"]["TEXCOORD_0"])
            pos = accessor(gltf, binb, prim["attributes"]["POSITION"])
            tris = (accessor(gltf, binb, prim["indices"]) if "indices" in prim else np.arange(len(uv))).reshape(-1, 3)
            ids = np.array([weld.setdefault(tuple(np.round(p, 5)), len(weld)) for p in pos])
            uvs.append(uv[tris])
            keys.append(ids[tris])
    return np.concatenate(uvs), np.concatenate(keys)


def adjacency(keys):
    """Vizinhos de cada triângulo pelas arestas compartilhadas."""
    edges = {}
    for t, (a, b, c) in enumerate(keys):
        for e in ((a, b), (b, c), (c, a)):
            edges.setdefault((min(e), max(e)), []).append(t)
    nb = [set() for _ in range(len(keys))]
    for ts in edges.values():
        for t in ts:
            nb[t].update(x for x in ts if x != t)
    return [np.fromiter(s, np.int64) for s in nb]


def labels(tri_px, w, h):
    """Id (1..n) do triângulo dono de cada texel; 0 = vão. O contorno entra (1 texel de folga)."""
    canvas = Image.new("I", (w, h), 0)
    draw = ImageDraw.Draw(canvas)
    for i, t in enumerate(tri_px, 1):
        draw.polygon([tuple(p) for p in t], fill=i, outline=i)
    return np.array(canvas, dtype=np.int64)


def tri_means(img, lab, tri_px):
    """Cor média de cada triângulo; o que não ganhou texel no raster usa o texel do centro."""
    h, w, c = img.shape
    n = len(tri_px) + 1
    flat = lab.ravel()
    cnt = np.bincount(flat, minlength=n).astype(np.float64)
    px = img.reshape(-1, c).astype(np.float64)
    mean = np.stack([np.bincount(flat, px[:, k], n) for k in range(c)], 1) / np.maximum(cnt, 1)[:, None]
    cen = tri_px.mean(1)
    cx = np.clip(cen[:, 0].astype(int) % w, 0, w - 1)
    cy = np.clip(cen[:, 1].astype(int) % h, 0, h - 1)
    empty = cnt[1:] == 0
    mean[1:][empty] = img[cy[empty], cx[empty]]
    return mean[1:]


def hsv(rgb):
    f = np.asarray(rgb, np.float64) / 255
    mx, mn = f.max(-1), f.min(-1)
    return np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0), mx


def bad_triangles(color, tri_px, nb, w, h):
    """Triângulos a repintar e a cor/valor (mediana dos vizinhos bons) de cada um, em índices."""
    cen = tri_px.mean(1) / [w, h]
    frame = (cen.min(1) < FRAME) | (cen.max(1) > 1 - FRAME)
    bad = np.zeros(len(color), bool)
    for _ in range(PASSES):
        med = np.full_like(color, np.nan)
        for t, ns in enumerate(nb):
            ok = ns[~bad[ns]] if len(ns) else ns
            if len(ok):
                med[t] = np.median(color[ok], 0)
        has = ~np.isnan(med[:, 0])
        dist = np.linalg.norm(color - np.nan_to_num(med), axis=1)
        ms, mv = hsv(np.nan_to_num(med))
        ts, _ = hsv(color)
        warm = (color[:, 0] > color[:, 1]) & (color[:, 0] > color[:, 2] + WARM_GAP) & (ts >= WARM_S)
        neutral_nb = (ms < NEUTRAL_S) & (mv < NEUTRAL_V)
        now = has & (((neutral_nb & warm) & (dist > WARM_DIST)) | (frame & (dist > FRAME_DIST)))
        if (now == bad).all():
            break
        bad = now
    return np.flatnonzero(bad)


def repaint(img, tri_px, which, values):
    """Pinta os triângulos `which` com `values` (uma cor por triângulo), repetindo do outro lado se o UV passa da borda."""
    h, w = img.shape[:2]
    canvas = Image.fromarray(img)
    draw = ImageDraw.Draw(canvas)
    for t, v in zip(which, values):
        fill = tuple(int(round(x)) for x in v)
        for ox in (-w, 0, w):
            for oy in (-h, 0, h):
                pts = [(p[0] + ox, p[1] + oy) for p in tri_px[t]]
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                if max(xs) < -1 or min(xs) > w or max(ys) < -1 or min(ys) > h:
                    continue
                draw.polygon(pts, fill=fill, outline=fill)
    return np.array(canvas)


def pad(img, cover):
    """Cresce as cores das ilhas para o vão, média dos vizinhos já preenchidos a cada passo."""
    h, w, c = img.shape
    col = np.where(cover[..., None], img, 0).astype(np.float32)
    filled = cover.copy()
    for _ in range(MAX_STEPS):
        if filled.all():
            break
        acc = np.zeros((h, w, c), np.float32)
        cnt = np.zeros((h, w), np.float32)
        pf = np.pad(filled, 1)
        pc = np.pad(col, ((1, 1), (1, 1), (0, 0)))
        for dy, dx in NEIGHBORS:
            f = pf[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            acc += pc[1 + dy:1 + dy + h, 1 + dx:1 + dx + w] * f[..., None]
            cnt += f
        new = (~filled) & (cnt > 0)
        col[new] = acc[new] / cnt[new][:, None]
        filled |= new
    if not filled.all():
        col[~filled] = col[filled].mean(0)
    return np.clip(np.rint(col), 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--textures", help="GLB de onde vêm as texturas (a origem 2k do Meshy, mesma malha e UV)")
    a = ap.parse_args()
    gltf, binb = read_glb(a.src)
    views = gltf["bufferViews"]
    blobs = [binb[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]] for v in views]
    if a.textures:
        tg, tb = read_glb(a.textures)
        tviews = tg["bufferViews"]
        if len(tg["images"]) != len(gltf["images"]):
            sys.exit("--textures: o número de imagens não bate com o do GLB")
        shape = lambda g: json.dumps([{k: v for k, v in x.items() if k not in ("bufferView", "byteOffset")} for x in g["accessors"]], sort_keys=True)  # noqa: E731
        if shape(tg) != shape(gltf):
            sys.exit("--textures: a malha/UV do GLB de origem não é a mesma")
        source_blob = {n: tb[tviews[img["bufferView"]].get("byteOffset", 0): tviews[img["bufferView"]].get("byteOffset", 0) + tviews[img["bufferView"]]["byteLength"]] for n, img in enumerate(tg["images"])}
    else:
        source_blob = {n: blobs[img["bufferView"]] for n, img in enumerate(gltf["images"])}
    mat = gltf["materials"][0]
    pbr = mat["pbrMetallicRoughness"]
    tex = gltf["textures"]
    ref = lambda r: tex[r["index"]]["source"] if r else None  # noqa: E731
    base, normal = ref(pbr.get("baseColorTexture")), ref(mat.get("normalTexture"))
    mr = ref(pbr.get("metallicRoughnessTexture"))
    sources = [s for s in (base, mr, normal) if s is not None]
    images = {}
    for n in sources:
        images[n] = np.array(Image.open(io.BytesIO(source_blob[n])).convert("RGB"))

    uv, keys = mesh_triangles(gltf, binb)
    nb = adjacency(keys)
    h, w = images[base].shape[:2]
    tri_px = uv * [w, h]
    lab = labels(tri_px, w, h)
    print(f"{len(uv)} triângulos | cobertura {(lab > 0).mean() * 100:.1f}% do atlas")
    color = tri_means(images[base], lab, tri_px)
    bad = bad_triangles(color, tri_px, nb, w, h)
    print(f"triângulos repintados: {len(bad)}")

    for n in sources:
        img = images[n]
        ih, iw = img.shape[:2]
        if (iw, ih) == (w, h):
            t_px, t_lab = tri_px, lab
        else:
            t_px = uv * [iw, ih]
            t_lab = labels(t_px, iw, ih)
        means = tri_means(img, t_lab, t_px)
        values = []
        for t in bad:
            ok = nb[t][~np.isin(nb[t], bad)]
            values.append(np.median(means[ok], 0) if len(ok) else means[t])
        img = repaint(img, t_px, bad, values)
        out_img = Image.fromarray(pad(img, t_lab > 0))
        # PNG, sem perda: o compress_glb.py reduz e codifica em JPEG depois.
        buf = io.BytesIO()
        out_img.save(buf, "PNG", optimize=True)
        info = gltf["images"][n]
        blobs[info["bufferView"]] = buf.getvalue()
        info["mimeType"] = "image/png"

    out_bin = bytearray()
    for v, blob in zip(views, blobs):
        out_bin += b"\0" * ((4 - len(out_bin) % 4) % 4)
        v["byteOffset"], v["byteLength"] = len(out_bin), len(blob)
        out_bin += blob
    gltf["buffers"] = [{"byteLength": len(out_bin)}]
    write_glb(a.dst, gltf, bytes(out_bin))
    print("ok:", a.dst)


if __name__ == "__main__":
    main()
