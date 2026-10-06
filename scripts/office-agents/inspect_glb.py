"""Inspeciona um GLB sem dependências de 3D: malhas, esqueleto, texturas e proporções.

Uso: python inspect_glb.py arquivo.glb [saida.png]
Gera uma silhueta frontal e lateral (pontos dos vértices + ossos) para ver a pose.
"""
import json
import re
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load(path):
    data = open(path, "rb").read()
    off, chunks = 12, []
    while off < len(data):
        clen, ctype = struct.unpack_from("<I4s", data, off)
        chunks.append((ctype, data[off + 8: off + 8 + clen]))
        off += 8 + clen
    return json.loads(chunks[0][1]), (chunks[1][1] if len(chunks) > 1 else b""), len(data)


def accessor(g, binb, i):
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    n = NCOMP[a["type"]]
    dt = np.dtype(COMP[a["componentType"]])
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", 0)
    if stride and stride != n * dt.itemsize:
        rows = [np.frombuffer(binb, dt, n, start + k * stride) for k in range(a["count"])]
        arr = np.array(rows)
    else:
        arr = np.frombuffer(binb, dt, a["count"] * n, start).reshape(a["count"], n)
    return arr.astype(np.float64) if a["componentType"] == 5126 else arr


def trs(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = node.get("translation", [0, 0, 0])
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * np.array(s)
    m[:3, 3] = t
    return m


def image_size(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", struct.unpack(">II", b[16:24])
    if b[:2] == b"\xff\xd8":
        i = 2
        while i < len(b):
            marker, ln = b[i + 1], struct.unpack(">H", b[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xC3:
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return "jpeg", (w, h)
            i += 2 + ln
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp", ("?", "?")
    return "?", ("?", "?")


def main():
    path = sys.argv[1]
    out_png = sys.argv[2] if len(sys.argv) > 2 else None
    g, binb, size = load(path)
    print(f"arquivo: {size / 1e6:.1f} MB | gerador: {g.get('asset', {}).get('generator')}")
    print("extensionsUsed:", g.get("extensionsUsed"), "| required:", g.get("extensionsRequired"))
    nodes = g.get("nodes", [])
    print(f"nós: {len(nodes)} | malhas: {len(g.get('meshes', []))} | skins: {len(g.get('skins', []))} | animações: {len(g.get('animations', []))}")

    # Mundo de cada nó.
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    world = {}

    def wm(i):
        if i not in world:
            world[i] = (wm(parent[i]) if i in parent else np.eye(4)) @ trs(nodes[i])
        return world[i]

    roots = [i for i in range(len(nodes)) if i not in parent]
    for r in roots:
        n = nodes[r]
        print(f"raiz: '{n.get('name')}' T={n.get('translation')} R={n.get('rotation')} S={n.get('scale')}")

    def mesh_world(ni, n):
        """Matriz que leva a malha ao mundo no bind. Com pele, o glTF ignora o nó da malha: vale
        junta × matriz inversa de bind (a mesma em todas as juntas no bind; usa a 1ª)."""
        if "skin" not in n:
            return wm(ni)
        sk = g["skins"][n["skin"]]
        if "inverseBindMatrices" not in sk:
            return wm(ni)
        ibm = accessor(g, binb, sk["inverseBindMatrices"])[0].reshape(4, 4).T
        return wm(sk["joints"][0]) @ ibm

    tris = verts = 0
    pts_all = []
    for ni, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        mesh = g["meshes"][n["mesh"]]
        for p in mesh["primitives"]:
            pos = accessor(g, binb, p["attributes"]["POSITION"])
            verts += len(pos)
            t = (g["accessors"][p["indices"]]["count"] // 3) if "indices" in p else len(pos) // 3
            tris += t
            print(f"malha '{mesh.get('name')}' (nó '{n.get('name')}', skin={n.get('skin')}): {len(pos)} vértices, {t} triângulos, atributos {sorted(p['attributes'])}, material {p.get('material')}")
            m = mesh_world(ni, n)
            pts_all.append((np.c_[pos, np.ones(len(pos))] @ m.T)[:, :3])
    print(f"TOTAL: {verts} vértices, {tris} triângulos")
    pts = np.vstack(pts_all)
    mn, mx = pts.min(0), pts.max(0)
    print(f"caixa (mundo, bind): min {np.round(mn, 3)} max {np.round(mx, 3)} -> altura Y {mx[1] - mn[1]:.3f}")

    for i, mat in enumerate(g.get("materials", [])):
        pbr = mat.get("pbrMetallicRoughness", {})
        print(f"material {i} '{mat.get('name')}': baseColorTex={pbr.get('baseColorTexture', {}).get('index')} mrTex={pbr.get('metallicRoughnessTexture', {}).get('index')} normal={mat.get('normalTexture', {}).get('index')} emissive={mat.get('emissiveTexture', {}).get('index')} metallic={pbr.get('metallicFactor')} rough={pbr.get('roughnessFactor')} alpha={mat.get('alphaMode')} doubleSided={mat.get('doubleSided')}")
    for i, img in enumerate(g.get("images", [])):
        if "bufferView" in img:
            bv = g["bufferViews"][img["bufferView"]]
            b = binb[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
            kind, (w, h) = image_size(b)
            print(f"imagem {i} '{img.get('name')}': {img.get('mimeType')} {kind} {w}x{h} {bv['byteLength'] / 1e6:.2f} MB")
        else:
            print(f"imagem {i}: externa {img.get('uri', '')[:60]}")

    joints_xy = {}
    for si, sk in enumerate(g.get("skins", [])):
        names = [nodes[j].get("name") for j in sk["joints"]]
        print(f"skin {si}: {len(names)} ossos -> {names}")
        for j in sk["joints"]:
            joints_xy[nodes[j].get("name")] = (wm(j)[:3, 3], parent.get(j))
    for a in g.get("animations", []):
        print(f"animação '{a.get('name')}': {len(a.get('channels', []))} canais")

    if joints_xy:
        def find(*keys):
            for name, (p, _) in joints_xy.items():
                # Sem o prefixo do Mixamo, com ou sem número e ":"/"_" (o GLTFExporter tira o ":").
                low = re.sub(r"^mixamorig\d*[:_]?", "", (name or "").lower())
                if low in keys:
                    return name, p
            return None, None

        def deg(a, b):
            v = b - a
            return np.degrees(np.arctan2(np.hypot(v[0], v[2]), -v[1]))

        for side in ("left", "right"):
            an, ap = find(f"{side}arm", f"{side}_arm", f"{side}upperarm")
            fn, fp = find(f"{side}forearm", f"{side}_forearm", f"{side}lowerarm")
            if ap is not None and fp is not None:
                print(f"braço {side}: {deg(ap, fp):.0f}° da vertical (0 = colado, ~45 = pose A, 90 = pose T)")
        foot_y = mn[1]
        for key in ("hips", "spine", "neck", "head", "leftarm", "leftforearm", "lefthand", "leftupleg", "leftleg", "leftfoot"):
            n, p = find(key)
            if p is not None:
                print(f"  {key:12s} '{n}': y={p[1] - foot_y:.3f} (do chão) x={p[0]:.3f} z={p[2]:.3f}")

        # Medidas do esqueleto no bind (m): segmentos dos dois lados, ombros, bacia e dedos.
        def seg(a, b):
            pa, pb = find(a)[1], find(b)[1]
            return float(np.linalg.norm(pb - pa)) if pa is not None and pb is not None else None

        med = {"altura_bind": round(float(mx[1] - mn[1]), 3)}
        for side, k in (("left", "E"), ("right", "D")):
            for label, a, b in (("coxa", "upleg", "leg"), ("canela", "leg", "foot"), ("braco", "arm", "forearm"), ("antebraco", "forearm", "hand")):
                v = seg(side + a, side + b)
                if v is not None:
                    med[f"{label}_{k}"] = round(v, 3)
        ombros = seg("leftarm", "rightarm")
        if ombros is not None:
            med["ombro_a_ombro"] = round(ombros, 3)
        hp = find("hips")[1]
        if hp is not None:
            med["bacia_do_chao"] = round(float(hp[1] - foot_y), 3)
        dedos = [nm for nm in joints_xy if re.search(r"hand(thumb|index|middle|ring|pinky)\d", (nm or "").lower())]
        med["ossos_de_dedo"] = len(dedos)
        print("medidas:", json.dumps(med, ensure_ascii=False))

    if out_png:
        W, H, pad = 1000, 900, 40
        img = Image.new("RGB", (W, H), (245, 245, 245))
        d = ImageDraw.Draw(img)
        span = (mx - mn).max()
        sc = (H - 2 * pad) / span
        views = [("frente (X,Y)", 0, 0), ("lado (Z,Y)", 2, W // 2)]
        for title, ax, ox in views:
            d.text((ox + 10, 10), title, fill=(0, 0, 0))
            cx = ox + W // 4
            sub = pts[:: max(1, len(pts) // 60000)]
            for p in sub:
                x = cx + (p[ax] - (mn[ax] + mx[ax]) / 2) * sc
                y = H - pad - (p[1] - mn[1]) * sc
                d.point((x, y), fill=(120, 140, 190))
            for name, (p, par) in joints_xy.items():
                x = cx + (p[ax] - (mn[ax] + mx[ax]) / 2) * sc
                y = H - pad - (p[1] - mn[1]) * sc
                d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(220, 30, 30))
        img.save(out_png)
        print("silhueta:", out_png)


if __name__ == "__main__":
    main()
