"""Treina LoRA com Unsloth — o caminho para sequência longa numa GPU de 8 GB.

O treinador padrão (`train-lora.py`) trava acima de ~512 tokens num modelo 7B: a
VRAM encosta no teto e o Windows passa a paginar (4-7 min por passo, sem erro
nenhum). O Unsloth reimplementa o gradient checkpointing e é a tentativa de
destravar isso — a mesma receita de dados, só o motor de treino muda.

Roda no env `unsloth` (ver docs/bench/AMBIENTE.md).

Uso:
    python scripts/bench/train-unsloth.py --dataset docs/bench/dataset/train.jsonl \
        --out docs/bench/lora-7b --base unsloth/Qwen2.5-Coder-7B-Instruct \
        --max-len 2048 --rank 16 --lr 1e-4 --epochs 2 [--max-steps 3] [--resume <adapter>]
"""

import argparse
import json
import os
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", "D:\\hf-cache")

from unsloth import FastLanguageModel  # noqa: E402  (precisa vir antes do transformers)

import torch  # noqa: E402
from datasets import Dataset  # noqa: E402
from transformers import DataCollatorForSeq2Seq, Trainer, TrainingArguments  # noqa: E402


def carregar(dataset_path: Path, tokenizer, max_len: int, modo: str):
    """`sft`: perda só na resposta. `texto`: documento corrido (aprender o idioma do repo)."""
    linhas = [json.loads(l) for l in dataset_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    limite = int(max_len * 3.2)
    exemplos = []

    for row in linhas:
        if modo == "texto":
            texto = row.get("text") or row["messages"][-1]["content"]
            ids = tokenizer(texto, truncation=True, max_length=max_len)["input_ids"]
            if len(ids) < 32:
                continue
            exemplos.append({"input_ids": ids, "labels": list(ids), "attention_mask": [1] * len(ids)})
            continue

        msgs = row["messages"]
        if sum(len(m["content"]) for m in msgs) >= limite:
            continue
        prompt = tokenizer.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
        completo = prompt + msgs[-1]["content"] + (tokenizer.eos_token or "")
        ids = tokenizer(completo, truncation=True, max_length=max_len)["input_ids"]
        prompt_len = len(tokenizer(prompt, truncation=True, max_length=max_len)["input_ids"])
        labels = list(ids)
        for i in range(min(prompt_len, len(labels))):
            labels[i] = -100
        exemplos.append({"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids)})

    return Dataset.from_list(exemplos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="unsloth/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--modo", default="sft", choices=["sft", "texto"])
    ap.add_argument("--resume", default="", help="adapter existente para continuar treinando")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--targets", default="q_proj,k_proj,v_proj,o_proj")
    args = ap.parse_args()

    iniciou = time.time()
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.resume or args.base,
        max_seq_length=args.max_len,
        dtype=None,          # deixa o Unsloth escolher (bf16 na Blackwell)
        load_in_4bit=True,
    )

    if not args.resume:
        model = FastLanguageModel.get_peft_model(
            model,
            r=args.rank,
            lora_alpha=args.rank * 2,
            lora_dropout=0.0,          # 0 é o caminho otimizado do Unsloth
            bias="none",
            target_modules=args.targets.split(","),
            use_gradient_checkpointing="unsloth",   # é aqui que a VRAM cai
            random_state=42,
        )

    dados = carregar(Path(args.dataset), tokenizer, args.max_len, args.modo)
    print(f"exemplos: {len(dados)} | modo: {args.modo} | seq: {args.max_len}", flush=True)
    if not len(dados):
        raise SystemExit("dataset vazio depois do filtro de tamanho — reduza --max-len ou gere exemplos menores")

    trainer = Trainer(
        model=model,
        train_dataset=dados,
        args=TrainingArguments(
            output_dir=args.out,
            num_train_epochs=args.epochs,
            max_steps=args.max_steps,
            per_device_train_batch_size=args.batch,
            gradient_accumulation_steps=args.accum,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            logging_steps=5,
            save_strategy="no",
            bf16=torch.cuda.is_bf16_supported(),
            fp16=not torch.cuda.is_bf16_supported(),
            optim="adamw_8bit",
            report_to=[],
            seed=42,
        ),
        data_collator=DataCollatorForSeq2Seq(tokenizer, padding=True),
    )
    resultado = trainer.train()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    tokenizer.save_pretrained(str(out))
    pico = torch.cuda.max_memory_reserved() / 1024**3
    (out / "treino.json").write_text(
        json.dumps(
            {
                "base": args.base,
                "resume": args.resume or None,
                "modo": args.modo,
                "exemplos": len(dados),
                "max_len": args.max_len,
                "rank": args.rank,
                "lr": args.lr,
                "epochs": args.epochs,
                "loss": round(float(resultado.training_loss), 4),
                "segundos": round(time.time() - iniciou, 1),
                "vram_pico_gb": round(pico, 2),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"pronto em {(time.time() - iniciou) / 60:.1f} min | VRAM pico {pico:.2f} GB -> {out}", flush=True)


if __name__ == "__main__":
    main()


