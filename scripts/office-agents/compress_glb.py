"""Reduz um GLB: texturas para JPEG em `lado` px e sem o clipe de animação embutido.

Uso: python compress_glb.py entrada.glb saida.glb [lado=1024]
Só mexe nas imagens e nas animações; malha, pele e esqueleto passam iguais.
"""
import io
import json
import struct
import sys

from PIL import Image


def read_glb(path):
    data = open(path, "rb").read()
    off, chunks = 12, []
    while off < len(data):
        clen, ctype = struct.unpack_from("<I4s", data, off)
        chunks.append((ctype, data[off + 8: off + 8 + clen]))
        off += 8 + clen
    return json.loads(chunks[0][1]), chunks[1][1]


def write_glb(path, gltf, binb):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    binb += b"\0" * ((4 - len(binb) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binb)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(binb), b"BIN\0") + binb)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    side = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    gltf, binb = read_glb(src)
    views = gltf["bufferViews"]
    blobs = [binb[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]] for v in views]

    # A textura de metal/rugosidade leva a máscara de tingimento no canal R (tint_mask.py):
    # JPEG sem subamostragem de cor (4:4:4), senão a borda da máscara borra e vaza.
    tex = gltf.get("textures", [])
    mr_images = {
        tex[m["pbrMetallicRoughness"]["metallicRoughnessTexture"]["index"]]["source"]
        for m in gltf.get("materials", [])
        if "metallicRoughnessTexture" in m.get("pbrMetallicRoughness", {})
    }
    for n, img in enumerate(gltf.get("images", [])):
        i = img["bufferView"]
        im = Image.open(io.BytesIO(blobs[i]))
        is_normal = (img.get("name") or "").lower().startswith("normal")
        im = im.convert("RGB").resize((side, side), Image.LANCZOS)
        out = io.BytesIO()
        if n in mr_images:
            im.save(out, "JPEG", quality=92, subsampling=0, optimize=True)
        else:
            im.save(out, "JPEG", quality=92 if is_normal else 85, optimize=True)
        blobs[i] = out.getvalue()
        img["mimeType"] = "image/jpeg"

    # O app anima pelos próprios canais: o clipe que veio do rig só pesa.
    dropped = len(gltf.pop("animations", []))

    # Remonta o BIN com os bufferViews na ordem, alinhados em 4 bytes.
    used = set()
    for a in gltf.get("accessors", []):
        if "bufferView" in a:
            used.add(a["bufferView"])
    for img in gltf.get("images", []):
        used.add(img["bufferView"])
    out, remap = bytearray(), {}
    for i, blob in enumerate(blobs):
        if i not in used:
            continue
        out += b"\0" * ((4 - len(out) % 4) % 4)
        v = dict(views[i])
        v["byteOffset"], v["byteLength"] = len(out), len(blob)
        v["buffer"] = 0
        remap[i] = (len(remap), v)
        out += blob
    gltf["bufferViews"] = [v for _, v in sorted(remap.values(), key=lambda x: x[0])]
    for a in gltf.get("accessors", []):
        if "bufferView" in a:
            a["bufferView"] = remap[a["bufferView"]][0]
    for img in gltf.get("images", []):
        img["bufferView"] = remap[img["bufferView"]][0]
    gltf["buffers"] = [{"byteLength": len(out)}]
    write_glb(dst, gltf, bytes(out))
    print(f"ok: {dst} | texturas {side}px JPEG | animações removidas: {dropped}")


if __name__ == "__main__":
    main()
