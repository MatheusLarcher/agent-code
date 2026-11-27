# Ambiente controlado: memórias de outra pessoa

Esta pasta fica FORA do repositório do agent-code de propósito. As memórias e os
resultados da pessoa de teste ficam só aqui: nada daqui vai para o repositório,
para o git ou para qualquer serviço além do modelo que faz a escolha (o mesmo
login Claude que o app usa nesta máquina).

(Este arquivo é copiado de `scripts/medicoes/ambiente-memorias/LEIAME.md` pelo
comando `--preparar`; editar a cópia daqui não muda o original.)

## Pastas

- `memorias\` — cole aqui a pasta de memórias da pessoa (os arquivos `.md`, com
  as subpastas como vieram). O script só LÊ essa pasta.
- `casos\` — o arquivo `casos.json` com os pedidos de teste e as memórias que
  deveriam ser escolhidas em cada um. `casos-exemplo.json` mostra o formato
  (é fictício: copie para `casos.json` e troque pelos casos reais da pessoa).
- `resultados\` — cada rodada cria uma subpasta com a data e a hora, contendo
  `resumo.md` (tabelas para ler) e `resultado.json` (tudo, bruto).

## Primeiro teste: quem escolhe melhor as memórias

Compara três jeitos de escolher as memórias de cada pedido:

- `sonnet` — o que o app usa hoje (Claude Sonnet 5.5);
- `haiku` — o Claude Haiku 5.5, mais rápido e barato;
- `lexical` — a busca por palavras, sem IA (a reserva do app).

Da raiz do repositório (`C:\projects\agent-code`):

```
npx esbuild scripts/medicoes/avaliar-escolha-memorias.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/.avaliar.tmp.mjs
node scripts/medicoes/.avaliar.tmp.mjs --preparar
node scripts/medicoes/.avaliar.tmp.mjs --pasta "%USERPROFILE%\agent-code-ambiente\memorias" --casos "%USERPROFILE%\agent-code-ambiente\casos\casos.json" --seletores sonnet,haiku,lexical --repeticoes 3
del scripts\medicoes\.avaliar.tmp.mjs
```

- `--preparar` cria esta pasta (só precisa uma vez; não apaga nem sobrescreve nada).
- `--exemplo <pasta>` copia um conjunto de memórias FICTÍCIAS para `<pasta>`,
  para ensaiar antes de as memórias reais chegarem (combine com
  `casos-exemplo.json`).
- Sem `--pasta`, `--casos` e `--saida`, o script usa as pastas daqui.
- `--repeticoes N` — quantas vezes cada seletor responde cada pedido (padrão 3).
- `--timeout MS` — tempo máximo por resposta do modelo (padrão 30000, o do app).
- `--seletores` — também aceita um id de modelo, ex.: `claude-opus-5-5`.
- `--sem-juiz` — desliga o juiz (veja abaixo); as memórias extras passam a
  contar como erro.

O script recusa gravar resultados dentro de um repositório git.

## O juiz das memórias extras

"Extra" é uma memória escolhida que não estava nas esperadas nem nas aceitáveis.
Nem toda extra é erro: às vezes ela ajuda mesmo. Por isso, cada extra vai ao
Claude Sonnet 5.5 junto com o pedido e o texto da memória (até 4000 caracteres),
e ele dá um veredito: `útil`, `neutra` ou `atrapalha`, com um motivo curto.

- O juiz vem ligado. `--sem-juiz` desliga.
- Os vereditos ficam guardados em `resultados\juiz-cache.json` (na pasta de
  `--saida`). Se o mesmo pedido, a mesma memória e o mesmo texto voltarem, o
  veredito vem de lá, sem pagar de novo. Apagar esse arquivo faz o juiz julgar
  tudo outra vez.
- O juiz avalia as extras de todos os seletores, inclusive da busca por palavras.

## Formato de casos.json

```json
{
  "casos": [
    {
      "id": "publicar-app",
      "pedido": "terminei a correção, pode gerar a versão para instalar",
      "esperadas": [
        "projetos/gerar-instalador.md",
        { "umaDe": ["regras/conferir-testes-antes.md", "regras/rodar-testes-antes-de-entregar.md"] }
      ],
      "aceitaveis": ["regras/nao-commitar-segredos.md"],
      "conversa": "(opcional) resumo do que veio antes na conversa",
      "nota": "(opcional) por que essas são as certas"
    },
    {
      "id": "cumprimento",
      "pedido": "bom dia!",
      "esperadas": []
    }
  ]
}
```

- `id` — um nome curto e único para o caso.
- `pedido` — a mensagem como a pessoa escreveria.
- `esperadas` — caminhos relativos à pasta `memorias\`, com `/`, exatamente
  como os arquivos estão. Lista vazia quer dizer "o certo é não escolher nada".
  Cada item é um caminho OU um grupo `{"umaDe": [caminhos]}`: memórias que dizem
  a mesma coisa (repetidas). O grupo vale como UMA esperada — qualquer uma delas
  basta, e escolher mais de uma do mesmo grupo não é erro. Grupo vazio é recusado;
  grupo de um caminho só vira caminho simples.
- `aceitaveis` — opcional; caminhos que tanto faz escolher ou não (o assunto é
  vizinho, mas também serve). Escolher uma delas conta como acerto na
  precisão; não escolher não faz falta na cobertura.
- Um mesmo caminho só pode aparecer em um lugar do caso (solto, em um grupo ou
  nas aceitáveis); o script recusa o arquivo se repetir.
- Duas memórias que se contradizem e valem as duas para o pedido NÃO são grupo:
  ponha as duas soltas, porque o certo é o seletor trazer as duas.
- `conversa` — opcional; vai ao modelo como o resumo da conversa, igual ao app.
- Memórias marcadas com `sempre: true` entram em toda conversa de qualquer
  jeito, então ficam fora da conta (nem contam como acerto nem como erro).

## Como ler o resumo

- **Nota (F1)** — a nota de cada pedido, de 0 a 100%, que junta precisão e
  cobertura numa conta só. O resumo mostra a média dos pedidos. É o número para
  comparar os seletores.
- **Cobertura** — das esperadas (cada grupo vale 1), quantas foram escolhidas.
- **Precisão** — das escolhidas que contam, quantas ajudam. Contam como acerto:
  as esperadas (um grupo atingido vale 1), as aceitáveis e as extras que o juiz
  achou úteis. Contam como erro: as extras que atrapalham e as extras sem
  veredito (juiz desligado ou sem resposta). As extras neutras e as outras do
  mesmo grupo ficam fora da conta.
- Esperado vazio e nada escolhido: nota 100%. Esperadas e nenhuma escolhida:
  nota 0.
- **Memórias por pedido** — quantas o seletor escolheu, em média.
- **Extras úteis / neutras / que atrapalham / sem juiz** — média por pedido.
- **Caracteres por pedido** — o tamanho do bloco de memórias que iria na
  conversa (o que de fato cabe no app).
- **Custo do seletor** e **custo do juiz** — aparecem separados. O do juiz só
  soma as avaliações novas; as do cache não custam nada.
- No resumo, um grupo aparece como "uma de (`a.md`, `b.md`)" e as aceitáveis
  numa linha própria, logo abaixo das esperadas.
- **Mesma escolha nas repetições** — em quantas das repetições 2, 3, ... o
  seletor escolheu exatamente o mesmo que na primeira (só aparece com 2+).
- **Tempo mediano / faixa** — quanto cada escolha levou.
- **Falhas** — vezes em que o modelo não decidiu (tempo esgotado, erro). No app,
  essas cairiam na busca por palavras. Ficam fora das médias.
- No "Por caso", cada extra aparece com o veredito e o motivo do juiz.
- A conta usa o que o seletor ESCOLHEU. O `resultado.json` também traz, em
  `entregues`, o que de fato caberia no bloco do app (que tem teto de tamanho).

Para um resultado confiável, monte uns 20 casos ou mais e use 3 repetições.
