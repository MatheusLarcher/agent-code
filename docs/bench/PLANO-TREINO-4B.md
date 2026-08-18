# Plano — treinar o qwen3:4b com dataset escrito à mão

Status: **planejado, não executado.** Escrito em 2026-08-04.

Objetivo: aprender a fazer LoRA direito num modelo barato de iterar (4b, ciclo de
minutos na RTX 5050) antes de gastar hora de GPU alugada num modelo grande.

---

## 1. Por que os LoRAs anteriores não funcionaram

Placar dos treinos feitos até aqui:

| modelo | base | com LoRA |
|---|---|---|
| qwen2.5-coder 7b | 14/22 | 17/22 |
| qwen3.6-35b | 19/22 | **17/22** |
| qwen3:4b | 17/22 | **13/22** (2 épocas) |
| desafio de função | 17/18 | 17/18 (empate) |

Um acerto em quatro.

A hipótese antiga era "83% do dataset é operação `Edit`". Essa já foi corrigida — o
`build-dataset-v2.mjs` ignora `Edit` de propósito e só usa arquivo completo.

**A causa real é o filtro por `max-len` no `train-lora.py` (linha 40).** Ele descarta
todo exemplo maior que `max_len × 3,2` chars. Medido em `train.jsonl` (208 exemplos):

```
--max-len  512 (padrão)   ->   8/208 sobrevivem  ( 3%)
--max-len 1024            ->  49/208             (23%)
--max-len 1280 (teto 4b)  ->  72/208             (34%)
--max-len 1792 (teto 8GB) -> 104/208             (50%)
```

Dois problemas:

1. **Com o padrão, o treino roda em 8 exemplos e joga 200 fora sem imprimir nada.**
   Parece que treinou nos 208.
2. O descarte é enviesado: sobram **os mais curtos**. O treino só vê arquivo pequeno e
   aprende a responder curto — que é exatamente o sintoma observado (resposta encurtou,
   o 35B caiu de 19 para 17).

Mediana do `train.jsonl`: 1.629 tokens (prompt+resposta), 947 só de resposta. O teto de
VRAM do 4b é 1.280. **`train.jsonl` não é treinável honestamente em 8 GB.**

Nota: o filtro está certo em não truncar — exemplo cortado no meio ensina o modelo a
parar no meio. O erro é descartar em silêncio, não o descarte em si.

---

## 2. A abordagem nova: exemplos escritos, não raspados

Em vez de extrair de commits automaticamente, o Opus **escreve** os exemplos de treino
(destilação professor→aluno).

Vantagens:

- Commit real vem com ruído: mudança sem relação, refactor pela metade, código depois
  desfeito. Exemplo escrito tem pedido e resposta alinhados.
- Resolve o tamanho na origem: escrito já cabendo em ~1.100 tokens. Sem descarte, sem corte.

Fonte de material: as memórias do usuário (regras de estilo) e o **formato** dos desafios
em `SPEC.md` / `SPEC-FUNCAO.md` — nunca o conteúdo deles (ver regra abaixo).

### O que das memórias entra

- **Regras de estilo → viram exemplo de código.** Toast em vez de aviso fixo no topo;
  busca case-insensitive e acento-insensível nos dois sentidos; app desktop de uma tela
  só com scroll interno por área.
- **Regras de processo → ficam de fora.** Não mexer no Hostinger, comitar na main, subir
  o Docker depois de editar. Não são código; treinar isso num 4b ensina a recitar,
  não a programar.

---

## 3. Regra inegociável: não contaminar a avaliação

**Nenhum exemplo de treino pode ser sobre os desafios avaliados.**

Se o dataset for escrito a partir do `SPEC.md` e a medição for nos mesmos 22 testes, isso
é treinar no gabarito. O resultado sairia ótimo (20/22, 21/22) e seria falso — o modelo
teria memorizado `isArchived` / `partitionArchived`, não aprendido a programar no projeto.
Pior: é o tipo de número que levaria a alugar GPU para escalar algo que não existe.

Concretamente:

- **Proibido no dataset:** arquivar conversas (os 22 testes de `acceptance/`), reconciliar
  listas (os 18 testes de `acceptance-funcao/`).
- **Permitido:** outros domínios do projeto — áudio/speech, IPC, streaming, store de
  conversas, componentes de UI não relacionados.
- Ler o SPEC para entender **como o pedido chega e como a resposta sai** é permitido.
  Copiar o problema, não.

Os dois conjuntos de teste permanecem cegos.

---

## 4. Formato do arquivo

Uma linha JSON por exemplo em `.jsonl` (não é um `.py`, nem um arquivo por exemplo):

```json
{"messages": [
  {"role": "system",    "content": "Você é um engenheiro sênior de TypeScript..."},
  {"role": "user",      "content": "<pedido + arquivos de contexto>"},
  {"role": "assistant", "content": "```ts\n// ARQUIVO: ...\n<código completo>\n```"}
]}
```

Usar o formato de `scripts/bench/format.mjs` (`SYSTEM`, `PROTOCOL`, `userMessage()`,
`assistantMessage()`) — é o mesmo que o harness usa na hora de testar. Treino e teste
precisam falar a mesma língua.

Restrições por exemplo:

- Teto de **1.100 tokens** (prompt + resposta), para caber no 4b com folga.
- Unidade semântica completa: função inteira ou componente inteiro, abrindo e fechando.
  Nunca um trecho cortado.
- Unidade que sozinha não couber é **descartada, nunca truncada**.

---

## 5. Passos

### 5.1 Consertar o descarte silencioso

Em `scripts/bench/train-lora.py`, o filtro da linha 40 deve:

- imprimir quantos exemplos entraram, quantos foram descartados e o `max-len` usado;
- **abortar** se descartar mais de 20%.

Isso impede que o próximo experimento minta. Fazer isso **antes** de qualquer treino.

### 5.2 Gerar o dataset

Meta inicial: **150 exemplos** — não 600.

Se 150 moverem o ponteiro, escalar para ~600 sabendo que funciona. Se não moverem, o
custo de descobrir isso foi 25%. Escrever 600 de cara é caro em token e arrisca pagar
tudo para aprender a mesma coisa.

Saída: `docs/bench/dataset/escrito-train.jsonl` + `escrito-eval.jsonl` (separar ~10%
para validação, sem sobreposição com o treino).

### 5.3 Treinar

Base: `qwen3:4b-instruct` (melhor modelo local medido: 17/22 e 18/18 na função, 70 tok/s).

Receita em `treino-local/receita-de-treino-lora.md`. Pontos de atenção já medidos:

- teto de `max-len` do 4b é **1.280** (o 7b aguenta 1.792);
- 3 épocas com lr 2e-4 causou overfit severo (9/22). Ficar em **2 épocas ou menos**;
- rank 8, seq 512 é o ponto estável conhecido (~4s/step).

### 5.4 Medir contra dois modelos, não um

O 4b já está em 17/22 e nenhum LoRA mexeu nele para cima. Se o próximo também não mexer,
não dá para saber se o dataset continua ruim ou se o 4b não tem folga — sinal confundido,
o pior resultado possível num experimento de aprendizado.

Por isso, o mesmo dataset em dois alvos:

- **4b** (17/22, ciclo barato)
- **7b** (14/22, folga comprovada — já subiu para 17)

Leitura:

| resultado | conclusão |
|---|---|
| subiu nos dois | dataset bom, pode escalar |
| subiu só no 7b | dataset ok, o 4b está no teto |
| **não subiu em nenhum** | **o dataset ainda está errado** |

### 5.5 Critério de corte (definir antes, não depois)

> O LoRA passa se **não regredir em nenhum dos dois** e **subir ≥2 pontos em pelo menos um**.

Medir com `run-local.mjs` (22 testes) e `run-funcao.mjs` (18 testes), em conjunto de teste
separado do de treino — senão mede memorização, não aprendizado.

Só depois de um dataset passar nesse critério é que faz sentido alugar GPU na Vast para
escalar a modelo maior. Alugar antes é pagar para descobrir o que a máquina local conta
de graça.

---

## 6. Decisões ainda em aberto

- [ ] Confirmar a exclusão dos dois desafios do dataset (seção 3).
- [ ] Quais domínios do projeto entram nos 150 exemplos.
- [ ] Se o alvo é gerar arquivo/feature completa ou função isolada. Treinando só em
      funções, o modelo aprende a escrever função, não a orquestrar uma feature — e o
      desafio de 22 testes pede a feature completa. Arquivo inteiro não cabe em 8 GB
      (mediana 1.629 tokens vs teto 1.280); para isso é que valeria a GPU alugada, aí
      sim com dado íntegro.

---

## Referências

- `scripts/bench/train-lora.py` — QLoRA 4-bit, o filtro problemático está na linha 40
- `scripts/bench/format.mjs` — formato único compartilhado entre treino e harness
- `scripts/bench/run-local.mjs` — harness dos 22 testes
- `scripts/bench/run-funcao.mjs` — harness dos 18 testes
- `docs/bench/resultados/` — histórico das medições
