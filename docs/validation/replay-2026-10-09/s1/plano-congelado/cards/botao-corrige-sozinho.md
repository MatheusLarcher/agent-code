---
id: "botao-corrige-sozinho"
tipo: "ambiguidade"
titulo: "O botão deve corrigir sozinho antes de commitar?"
etapa: "regras-commit"
status: "resolvida"
links: ["estado-atual-botao","commit-como-flag"]
rev: 2
---
## O que está ambíguo

O pedido diz "depois que roda o review e corrigir, rode um commit". Hoje o botão só revisa (não manda `--fix`). Leituras:
A) Um clique faz tudo: review → corrige os achados confirmados → checks → commit (`/code-review --fix --commit`).
B) O botão continua só revisando; o commit vem depois que o usuário pedir a correção. Isso não cabe no botão: o turno seguinte é texto livre do usuário, o botão não controla o que vem depois.

## Cards envolvidos

- [[Estado atual do botão de code review]]
- [[Commit como flag --commit, ligado só pelo botão]]

## Opinião do Manager

Seguir A. É a única leitura que o botão consegue garantir "sempre". O risco (corrigir sem o usuário aprovar cada achado) é pequeno no esforço padrão medium, que só reporta achados de alta confiança, e o commit é local e reversível (`git reset HEAD~1`).

## Decisão (2026-10-09)

O usuário escolheu a leitura A: um clique faz tudo. O botão envia `/code-review --fix --commit`: revisa, corrige os achados confirmados, roda os checks e commita.
