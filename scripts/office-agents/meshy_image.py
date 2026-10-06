"""Gera a imagem de um personagem do Escritório no Meshy (Image to Image), a partir de fotos/referências.

Uso: python meshy_image.py <saida-prefixo> <prompt.txt> <modelo> <ref1.png> [ref2.png ...]
Modelos: gpt-image-2 (12 créditos), nano-banana-pro (9), nano-banana-2 (6)...
Saída: <prefixo>-<n>.png (fundo transparente, retrato 2:3) e <prefixo>-run.json com o id da
tarefa: rodar de novo retoma a mesma tarefa em vez de pagar outra.
A chave vem de MESHY_API_KEY ou de %USERPROFILE%\\.meshy\\api-key.txt (nunca é impressa).
Saldo: python meshy_image.py --saldo
"""
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.request

API = "https://api.meshy.ai/openapi/v1"


def api_key():
    key = os.environ.get("MESHY_API_KEY", "").strip()
    path = os.path.join(os.path.expanduser("~"), ".meshy", "api-key.txt")
    if not key and os.path.exists(path):
        key = open(path, encoding="utf-8").read().strip()
    if not key:
        sys.exit("Sem chave: defina MESHY_API_KEY ou salve em %USERPROFILE%\\.meshy\\api-key.txt")
    return key


def call(method, path, body=None):
    req = urllib.request.Request(
        f"{API}/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} em {method} {path}: {e.read().decode(errors='replace')[:500]}")


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()


def main():
    if sys.argv[1:2] == ["--saldo"]:
        print("saldo:", call("GET", "balance"))
        return
    prefix, prompt_file, model, *refs = sys.argv[1:]
    run_path = f"{prefix}-run.json"
    run = json.load(open(run_path)) if os.path.exists(run_path) else {}
    if not run.get("task"):
        body = {
            "ai_model": model,
            "prompt": open(prompt_file, encoding="utf-8").read().strip(),
            "reference_image_urls": [data_uri(r) for r in refs],
            "aspect_ratio": "2:3" if model.startswith("gpt") else "3:4",
            "remove_background": True,
        }
        run = {"task": call("POST", "image-to-image", body)["result"], "model": model}
        json.dump(run, open(run_path, "w"), indent=1)
    print("tarefa:", run["task"])
    while True:
        t = call("GET", f"image-to-image/{run['task']}")
        if t["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
            break
        print(f"  {t['status']} {t.get('progress', 0)}%")
        time.sleep(5)
    if t["status"] != "SUCCEEDED":
        sys.exit(f"falhou: {json.dumps(t.get('task_error') or t)[:400]}")
    for i, url in enumerate(t.get("image_urls", [])):
        out = f"{prefix}-{i + 1}.png"
        urllib.request.urlretrieve(url, out)
        print("ok:", out)
    run["status"] = "SUCCEEDED"
    json.dump(run, open(run_path, "w"), indent=1)


if __name__ == "__main__":
    main()
