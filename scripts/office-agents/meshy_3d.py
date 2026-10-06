"""Gera o modelo 3D com esqueleto de um personagem do Escritório no Meshy: imagem → 3D (pose T,
triângulos, com textura) e o auto-rig do Meshy (esqueleto humanoide, sem dedos).

Uso: python meshy_3d.py <imagem.png> <saida-prefixo> [polígonos=30000] [altura_m=1.75] [--pbr] [--pose a-pose|t-pose]
  --pbr   texturas PBR (metal/rugosidade e normal) além da cor: o tint_mask.py grava a máscara da
          roupa no canal R da textura de metal/rugosidade, então o elenco tingível precisa dela.
  --pose  pose do modelo gerado (padrão t-pose; o v1 e o elenco usam a-pose).
Saída: <prefixo>-modelo.glb (sem esqueleto), <prefixo>-rig.glb (com esqueleto) e
<prefixo>-run.json com os ids das tarefas: rodar de novo retoma as mesmas tarefas em vez de
pagar outras. A chave vem de MESHY_API_KEY ou de %USERPROFILE%\\.meshy\\api-key.txt (nunca é
impressa). O GLB com esqueleto ainda passa pelo compress_glb.py antes de ir para resources/.
"""
import base64
import json
import os
import sys
import time
import urllib.request

from meshy_image import api_key  # noqa: F401  (mesma leitura da chave)

API = "https://api.meshy.ai/openapi/v1"


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Meshy {method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:500]}")


def wait(kind, task):
    while True:
        t = call("GET", f"{kind}/{task}")
        status = t.get("status")
        print(f"  {kind}: {status} {t.get('progress', '')}%", flush=True)
        if status == "SUCCEEDED":
            return t
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            sys.exit(f"{kind} {task}: {status} {t.get('task_error')}")
        time.sleep(8)


def download(url, path):
    with urllib.request.urlopen(url, timeout=300) as r, open(path, "wb") as f:
        f.write(r.read())
    print(f"  salvo: {path} ({os.path.getsize(path) / 1e6:.1f} MB)")


def parse_args(argv):
    """Posicionais (imagem, prefixo, [polígonos], [altura]) e as opções --pbr e --pose."""
    pos, pbr, pose = [], False, "t-pose"
    it = iter(argv)
    for a in it:
        if a == "--pbr":
            pbr = True
        elif a == "--pose":
            pose = next(it, "")
        elif a.startswith("--pose="):
            pose = a.split("=", 1)[1]
        else:
            pos.append(a)
    if pose not in ("a-pose", "t-pose"):
        sys.exit("--pose: a-pose ou t-pose")
    if len(pos) < 2:
        sys.exit(__doc__)
    return pos, pbr, pose


def main():
    pos, pbr, pose = parse_args(sys.argv[1:])
    image, prefix = pos[0], pos[1]
    poly = int(pos[2]) if len(pos) > 2 else 30000
    height = float(pos[3]) if len(pos) > 3 else 1.75
    run_path = f"{prefix}-run.json"
    run = json.load(open(run_path)) if os.path.exists(run_path) else {}

    if "model_task" not in run:
        data = base64.b64encode(open(image, "rb").read()).decode()
        body = {
            "image_url": f"data:image/png;base64,{data}",
            "ai_model": "latest",
            "topology": "triangle",
            "target_polycount": poly,
            "should_remesh": True,
            "should_texture": True,
            "enable_pbr": pbr,
            "symmetry_mode": "auto",
            "pose_mode": pose,
        }
        run["model_task"] = call("POST", "image-to-3d", body)["result"]
        run["options"] = {"polycount": poly, "pbr": pbr, "pose": pose, "height_m": height}
        json.dump(run, open(run_path, "w"), indent=1)
    print("imagem → 3D:", run["model_task"])
    model = wait("image-to-3d", run["model_task"])
    if not os.path.exists(f"{prefix}-modelo.glb"):
        download(model["model_urls"]["glb"], f"{prefix}-modelo.glb")

    if "rig_task" not in run:
        run["rig_task"] = call("POST", "rigging", {"input_task_id": run["model_task"], "height_meters": height})["result"]
        json.dump(run, open(run_path, "w"), indent=1)
    print("esqueleto:", run["rig_task"])
    rig = wait("rigging", run["rig_task"])
    res = rig.get("result") or {}
    url = res.get("rigged_character_glb_url")
    if not url:
        sys.exit(f"rigging sem GLB: {json.dumps(res)[:400]}")
    if not os.path.exists(f"{prefix}-rig.glb"):
        download(url, f"{prefix}-rig.glb")
    run["status"] = "SUCCEEDED"
    json.dump(run, open(run_path, "w"), indent=1)


if __name__ == "__main__":
    main()
