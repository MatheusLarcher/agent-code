"""Treina um LoRA do Qwen2.5-Coder-7B-Instruct com os dados deste projeto.

QLoRA 4-bit para caber nos 8 GB da RTX 5050. O adapter resultante é convertido
depois para GGUF e servido pelo Ollama junto do modelo base (ADAPTER no Modelfile).

Uso:
    python scripts/bench/train-lora.py --dataset docs/bench/dataset/train.jsonl --out docs/bench/lora-out
"""

import argparse
import json
import os
import time
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)

DEFAULT_BASE = "Qwen/Qwen2.5-Coder-7B-Instruct"
# 8 GB de VRAM: se o pico encostar no teto, o driver do Windows passa a paginar e
# o step vai de segundos para MINUTOS (medido: 8 min/step com seq 1536 num 7B).
# O valor certo depende do modelo — passe --max-len.
MAX_LEN = 512


def build(dataset_path: Path, tokenizer, max_len: int):
    rows = [json.loads(line) for line in dataset_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    # Exemplo que não cabe entra truncado no meio de uma função e ensina o modelo a
    # parar no meio. O corte em chars é conservador: ~3,5 chars por token.
    limite_chars = int(max_len * 3.2)
    rows = [r for r in rows if sum(len(m["content"]) for m in r["messages"]) < limite_chars]

    def encode(row):
        # O prompt entra com o template de chat do próprio modelo; a perda é
        # calculada só sobre a resposta (o que queremos que ele aprenda a escrever).
        msgs = row["messages"]
        prompt = tokenizer.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
        full = prompt + msgs[-1]["content"] + tokenizer.eos_token
        ids = tokenizer(full, truncation=True, max_length=max_len)["input_ids"]
        prompt_len = len(tokenizer(prompt, truncation=True, max_length=max_len)["input_ids"])
        labels = list(ids)
        for i in range(min(prompt_len, len(labels))):
            labels[i] = -100
        return {"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids)}

    return Dataset.from_list([encode(r) for r in rows])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--limit", type=int, default=0, help="usa só os N primeiros exemplos")
    ap.add_argument("--max-steps", type=int, default=-1, help="corta o treino em N steps (medição)")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--max-len", type=int, default=MAX_LEN)
    ap.add_argument("--rank", type=int, default=8)
    # `alpha/rank` é o ganho com que o adapter entra no modelo. Separado do rank de
    # propósito: num modelo pequeno, capacidade a mais quebra (rank 16 degenerou),
    # mas o GANHO é outro eixo — dá para manter o rank baixo e mexer só na força.
    ap.add_argument("--alpha", type=int, default=0, help="lora_alpha (0 = rank*2)")
    ap.add_argument("--targets", default="q_proj,k_proj,v_proj,o_proj")
    ap.add_argument("--lr", type=float, default=2e-4)
    # Modelo pequeno cabe inteiro na GPU: treinar em bf16 usa a MESMA precisão do
    # servidor de inferência, então a comparação base-vs-treinado não mistura
    # quantização com efeito de treino.
    ap.add_argument("--no-4bit", action="store_true", help="treina em bf16 puro (modelo pequeno)")
    args = ap.parse_args()

    started = time.time()
    tokenizer = AutoTokenizer.from_pretrained(args.base)
    data = build(Path(args.dataset), tokenizer, args.max_len)
    if args.limit:
        data = data.select(range(min(args.limit, len(data))))
    print(f"exemplos tokenizados: {len(data)}", flush=True)

    quant = (
        None
        if args.no_4bit
        else BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=quant,
        dtype=torch.bfloat16,
        device_map={"": 0},
    )
    model.config.use_cache = False
    if quant is not None:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    else:
        model.gradient_checkpointing_enable()
    model = get_peft_model(
        model,
        LoraConfig(
            r=args.rank,
            lora_alpha=args.alpha or args.rank * 2,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            # Conferir os nomes reais do modelo antes: arquitetura com atenção
            # linear/MoE não tem q/k/v/o em todas as camadas e o LoRA sai inócuo.
            target_modules=args.targets.split(","),
        ),
    )
    model.print_trainable_parameters()

    trainer = Trainer(
        model=model,
        train_dataset=data,
        args=TrainingArguments(
            output_dir=args.out,
            num_train_epochs=args.epochs,
            max_steps=args.max_steps,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            gradient_checkpointing=True,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            logging_steps=10,
            save_strategy="no",
            bf16=True,
            optim="paged_adamw_8bit",
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
    os.environ.setdefault("HF_HOME", "D:\\hf-cache")
    main()
