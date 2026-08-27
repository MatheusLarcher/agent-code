"""Serve um modelo HF (com ou sem adapter LoRA) falando o mesmo dialeto do Ollama.

Existe para um caso só: quando o adapter não pode ser convertido para GGUF, as duas
rodadas (base e treinado) precisam acontecer no mesmo lugar e no mesmo formato —
senão a comparação mistura quantização com treino. Com isto, o harness do
benchmark aponta para cá com `--host` e não muda mais nada.

Uso:
    python serve-ollama-like.py --model Qwen/Qwen3.6-35B-A3B [--adapter lora-35b] --port 11434
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

STATE = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):  # noqa: N802
        if self.path not in ("/api/chat", "/api/generate"):
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body.get("messages") or [{"role": "user", "content": body.get("prompt", "")}]
        options = body.get("options") or {}

        tokenizer, model = STATE["tokenizer"], STATE["model"]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(text, return_tensors="pt").to(model.device)
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)

        kwargs = dict(
            **inputs,
            streamer=streamer,
            max_new_tokens=int(options.get("num_predict") or 16000),
            do_sample=False,
        )
        threading.Thread(target=model.generate, kwargs=kwargs, daemon=True).start()

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        started = time.time()
        count = 0
        for piece in streamer:
            count += len(tokenizer(piece)["input_ids"])
            self._chunk(json.dumps({"message": {"role": "assistant", "content": piece}, "done": False}) + "\n")
        elapsed = time.time() - started
        self._chunk(
            json.dumps(
                {
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "eval_count": count,
                    "eval_duration": int(elapsed * 1e9),
                    "prompt_eval_count": int(inputs["input_ids"].shape[1]),
                }
            )
            + "\n"
        )
        self._chunk("")

    def _chunk(self, payload: str):
        data = payload.encode()
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter")
    ap.add_argument("--port", type=int, default=11434)
    ap.add_argument("--load-4bit", action="store_true", help="para GPU pequena: nf4 via bitsandbytes")
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    extra = {}
    if args.load_4bit:
        from transformers import BitsAndBytesConfig

        extra["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16
        )
    # `attn_implementation="sdpa"` explícito: com um adapter PEFT carregado por
    # cima, o modelo cai no caminho "eager", que materializa a matriz de atenção
    # inteira. Num prompt de ~20 mil tokens isso é quadrático e o servidor morreu
    # com `CUDA out of memory: tried to allocate 17.54 GiB` numa GPU de 8 GB — a
    # rodada BASE, sem adapter, tinha passado no mesmo prompt.
    model = AutoModelForCausalLM.from_pretrained(
        args.model, dtype=torch.bfloat16, device_map={"": 0}, attn_implementation="sdpa", **extra
    )
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"adapter carregado: {args.adapter}", flush=True)
    model.eval()
    STATE["tokenizer"], STATE["model"] = tokenizer, model

    print(f"servindo em 0.0.0.0:{args.port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
