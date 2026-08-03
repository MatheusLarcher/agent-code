"""Treina o LoRA do Qwen3.6-35B-A3B com os dados deste projeto, numa GPU alugada.

Roda em bf16 puro (sem bitsandbytes): com 96 GB de VRAM os 70 GB de pesos cabem e
sai um caminho a menos para dar errado. Mesma receita do LoRA local (r=8, só as
camadas de atenção), para que a comparação entre os dois modelos seja de modelo,
não de hiperparâmetro.

Uso (na instância):
    python train-lora-35b.py --dataset train.jsonl --out lora-35b
"""

import argparse
import json
import time
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, DataCollatorForLanguageModeling, Trainer, TrainingArguments

BASE = "Qwen/Qwen3.6-35B-A3B"
MAX_LEN = 1536


def build(dataset_path: Path, tokenizer):
    rows = [json.loads(line) for line in dataset_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [r for r in rows if len(r["messages"][0]["content"]) + len(r["messages"][-1]["content"]) < 2200]

    def encode(row):
        msgs = row["messages"]
        prompt = tokenizer.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
        full = prompt + msgs[-1]["content"] + (tokenizer.eos_token or "")
        ids = tokenizer(full, truncation=True, max_length=MAX_LEN)["input_ids"]
        prompt_len = len(tokenizer(prompt, truncation=True, max_length=MAX_LEN)["input_ids"])
        labels = list(ids)
        for i in range(min(prompt_len, len(labels))):
            labels[i] = -100
        return {"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids)}

    return Dataset.from_list([encode(r) for r in rows])


def load_model():
    """O 3.6 é multimodal; se a classe causal não servir, cai na de image-text."""
    try:
        return AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16, device_map={"": 0})
    except Exception as e:  # noqa: BLE001
        print(f"AutoModelForCausalLM falhou ({e}); tentando AutoModelForImageTextToText", flush=True)
        from transformers import AutoModelForImageTextToText

        return AutoModelForImageTextToText.from_pretrained(BASE, dtype=torch.bfloat16, device_map={"": 0})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=2.0)
    args = ap.parse_args()

    started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(BASE)
    data = build(Path(args.dataset), tokenizer)
    print(f"exemplos tokenizados: {len(data)}", flush=True)

    model = load_model()
    model.config.use_cache = False
    model = get_peft_model(
        model,
        LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            # O 3.6 alterna atenção clássica (10 camadas: q/k/v/o_proj) com linear
            # attention (30 camadas: in_proj_qkv/out_proj). Mirar só em q/k/v/o
            # treinava 1,7 M de parâmetros — 0,005% do modelo, LoRA quase inócuo.
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "in_proj_qkv", "out_proj"],
        ),
    )
    model.print_trainable_parameters()

    trainer = Trainer(
        model=model,
        train_dataset=data,
        args=TrainingArguments(
            output_dir=args.out,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            gradient_checkpointing=True,
            learning_rate=2e-4,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            logging_steps=10,
            save_strategy="no",
            bf16=True,
            optim="adamw_torch",
            report_to=[],
        ),
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
    )
    trainer.train()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    tokenizer.save_pretrained(out)
    (out / "treino.json").write_text(
        json.dumps({"exemplos": len(data), "epochs": args.epochs, "segundos": round(time.time() - started, 1)}, indent=2),
        encoding="utf-8",
    )
    print(f"pronto em {(time.time() - started) / 60:.1f} min -> {out}", flush=True)


if __name__ == "__main__":
    main()
