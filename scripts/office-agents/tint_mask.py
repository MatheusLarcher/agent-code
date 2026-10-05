"""Grava a máscara de tingimento da roupa principal num GLB de agente do Escritório.

Uso: python tint_mask.py entrada.glb saida.glb [--hue 190-250] [--preview mascara.png]

A roupa principal de todo personagem sai azul saturado (o suéter do v1). A máscara
pega os texels da cor-base na faixa de matiz (190–250°), com saturação > 60 e
valor > 25 (escala 0–255 do HSV do Pillow), e LIMPA o ruído pela malha: cada
triângulo é da roupa se mais da metade dos texels dele é azul (o fio azulado
solto na calça não entra; a ilha pequena do suéter não some), com 2 texels de
folga na borda das ilhas da roupa e a margem azul pintada fora delas (o
mipmap de longe a mistura). Vai para o canal R da textura de
metal/rugosidade, que o glTF não usa (G = rugosidade, B = metal); o shader do
app (agentTint.ts) troca a cor desses texels pela do agente. A luma média
(linear) da roupa vai em materials[0].extras.tintMeanLuma: o shader escala a cor
do agente por luma/média, e o tricô e as dobras continuam.

Requisitos: Python 3 + Pillow + numpy.
"""
import argparse
import io
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compress_glb import read_glb, write_glb  # noqa: E402
from inspect_glb import accessor  # noqa: E402

# Fração mínima de texels azuis para o triângulo ser da roupa.
TRI_SHARE = 0.5
# Folga (texels) em volta das ilhas da roupa: a amostragem bilinear na borda da ilha não deixa fio sem cor.
PAD = 2
# A margem que o gerador pinta fora das ilhas (a cor da borda esticada): o mipmap de longe a mistura.
MARGIN = 12


def dilate(m, it):
    out = m.copy()
    for _ in range(it):
        p = np.pad(out, 1)
        out = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return out


def raster_triangles(uv, tris, w, h, raw):
    """Classifica cada triângulo pela fração de texels azuis e pinta os da roupa e os outros."""
    cloth = np.zeros((h, w), bool)
    other = np.zeros((h, w), bool)
    px = np.stack([uv[:, 0] * w, uv[:, 1] * h], 1)
    kept = 0
    for t in tris:
        a, b, c = px[t[0]], px[t[1]], px[t[2]]
        x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(w - 1, np.ceil(max(a[0], b[0], c[0]))))
        y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(h - 1, np.ceil(max(a[1], b[1], c[1]))))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            inside = np.zeros_like(xs, bool)
        else:
            l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
            l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
            inside = (l1 >= -1e-3) & (l2 >= -1e-3) & (1 - l1 - l2 >= -1e-3)
        if not inside.any():
            # Triângulo menor que um texel: vale o texel do centro.
            cx, cy = int(min(w - 1, (a[0] + b[0] + c[0]) / 3)), int(min(h - 1, (a[1] + b[1] + c[1]) / 3))
            (cloth if raw[cy, cx] else other)[cy, cx] = True
            continue
        sub = raw[y0:y1 + 1, x0:x1 + 1]
        is_cloth = sub[inside].mean() > TRI_SHARE
        kept += is_cloth
        target = cloth if is_cloth else other
        target[y0:y1 + 1, x0:x1 + 1] |= inside
    return cloth, other, kept


def mask_from_color(rgb, lo, hi, uv, tris, side=1024):
    """Máscara por triângulo da malha: o pontinho azul na calça não vira roupa e a ilha pequena do suéter não some."""
    hsv = np.array(rgb.convert("HSV").resize((side, side), Image.BILINEAR)).astype(np.float32)
    h_deg = hsv[..., 0] * 360 / 255
    raw = (h_deg >= lo) & (h_deg <= hi) & (hsv[..., 1] > 60) & (hsv[..., 2] > 25)
    cloth, other, kept = raster_triangles(uv, tris, side, side, raw)
    near = dilate(cloth, MARGIN) & ~other
    m = cloth | (dilate(cloth, PAD) & ~other) | (near & raw)
    print(f"triângulos da roupa: {kept} de {len(tris)}")
    return raw, m


def srgb_to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--hue", default="190-250")
    ap.add_argument("--preview")
    a = ap.parse_args()
    lo, hi = (float(x) for x in a.hue.split("-"))
    gltf, binb = read_glb(a.src)
    views = gltf["bufferViews"]
    blobs = [binb[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]] for v in views]
    mat = gltf["materials"][0]
    pbr = mat["pbrMetallicRoughness"]
    tex = gltf["textures"]
    color_img = tex[pbr["baseColorTexture"]["index"]]["source"]
    mr_img = tex[pbr["metallicRoughnessTexture"]["index"]]["source"]
    occ = mat.get("occlusionTexture")
    if occ and tex[occ["index"]]["source"] == mr_img:
        sys.exit("a textura de metal/rugosidade carrega a oclusão no canal R: a máscara apagaria a oclusão")

    def image(i):
        return Image.open(io.BytesIO(blobs[gltf["images"][i]["bufferView"]]))

    rgb = image(color_img).convert("RGB")
    prim = next(p for mesh in gltf["meshes"] for p in mesh["primitives"] if p.get("material", 0) == 0)
    uv = accessor(gltf, binb, prim["attributes"]["TEXCOORD_0"])
    tris = accessor(gltf, binb, prim["indices"]).reshape(-1, 3).astype(np.int64)
    raw, m = mask_from_color(rgb, lo, hi, uv, tris)
    mr = image(mr_img).convert("RGB")
    mask_img = Image.fromarray(m.astype(np.uint8) * 255).resize(mr.size, Image.BILINEAR)
    r, g, b = mr.split()
    out = Image.merge("RGB", (mask_img, g, b))
    buf = io.BytesIO()
    out.save(buf, "PNG")
    blobs[gltf["images"][mr_img]["bufferView"]] = buf.getvalue()
    gltf["images"][mr_img]["mimeType"] = "image/png"

    # Luma média (linear) da roupa, na resolução da máscara.
    col = np.array(rgb.resize((m.shape[1], m.shape[0]), Image.BILINEAR)).astype(np.float32)
    lin = srgb_to_linear(col)
    luma = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    mean = float(luma[m].mean()) if m.any() else 0.12
    mat.setdefault("extras", {})["tintMeanLuma"] = round(mean, 5)

    rough = np.array(g).astype(np.float32) / 255
    metal = np.array(b).astype(np.float32) / 255
    print(f"máscara: crua {raw.mean() * 100:.1f}% -> limpa {m.mean() * 100:.1f}% da textura | luma média {mean:.4f}")
    print(f"rugosidade: média {rough.mean():.2f} (p5 {np.percentile(rough, 5):.2f}) | metal: média {metal.mean():.2f} (p95 {np.percentile(metal, 95):.2f})")
    if a.preview:
        prev = np.array(rgb.resize((m.shape[1], m.shape[0]))).copy()
        prev[m] = (prev[m] * 0.3 + np.array([255, 0, 200]) * 0.7).astype(np.uint8)
        Image.fromarray(prev).save(a.preview)
        print("prévia:", a.preview)

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
