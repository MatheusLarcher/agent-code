"""Exporta a malha texturizada de um GLB (saída do imagem→3D do Meshy) como ZIP para o Mixamo.

Uso: python glb_to_obj_zip.py entrada.glb saida.zip
O Mixamo aceita FBX, OBJ ou ZIP (OBJ + MTL + texturas); GLB não. O ZIP leva a malha com
UVs e normais e a textura de cor, para o personagem aparecer colorido na hora de marcar
queixo, pulsos, cotovelos, joelhos e virilha.
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inspect_glb import accessor, load  # noqa: E402


def main():
    src, dst = sys.argv[1], sys.argv[2]
    g, binb, _ = load(src)
    if len(g.get("meshes", [])) != 1 or len(g["meshes"][0]["primitives"]) != 1:
        sys.exit("esperava uma malha com uma primitiva (saída do imagem→3D)")
    prim = g["meshes"][0]["primitives"][0]
    pos = accessor(g, binb, prim["attributes"]["POSITION"])
    nor = accessor(g, binb, prim["attributes"]["NORMAL"])
    uv = accessor(g, binb, prim["attributes"]["TEXCOORD_0"])
    idx = accessor(g, binb, prim["indices"]).reshape(-1, 3) + 1

    mat = g["materials"][prim.get("material", 0)]
    tex = g["textures"][mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    img = g["images"][tex["source"]]
    bv = g["bufferViews"][img["bufferView"]]
    color = binb[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    ext = "png" if img.get("mimeType") == "image/png" else "jpg"

    obj = io.StringIO()
    obj.write("mtllib model.mtl\no agente\n")
    obj.writelines(f"v {x:.6f} {y:.6f} {z:.6f}\n" for x, y, z in pos)
    # glTF tem a origem da UV no topo; OBJ, embaixo.
    obj.writelines(f"vt {u:.6f} {1 - v:.6f}\n" for u, v in uv)
    obj.writelines(f"vn {x:.6f} {y:.6f} {z:.6f}\n" for x, y, z in nor)
    obj.write("usemtl pele\n")
    obj.writelines(f"f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}\n" for a, b, c in idx)
    mtl = f"newmtl pele\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nmap_Kd basecolor.{ext}\n"

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("model.obj", obj.getvalue())
        z.writestr("model.mtl", mtl)
        z.writestr(f"basecolor.{ext}", color)
    print(f"ok: {dst} ({os.path.getsize(dst) / 1e6:.1f} MB) | {len(pos)} vértices, {len(idx)} triângulos")


if __name__ == "__main__":
    main()
