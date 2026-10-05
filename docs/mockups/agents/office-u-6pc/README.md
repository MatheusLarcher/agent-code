# Escritório em U — 6 PCs

Mockup independente do Agent Code, baseado em `../agent-bays-u-6pc-v1.png`.

## Escopo e execução

- Cena 3D com dois PCs ao fundo e dois em cada lateral, telas para a câmera e corredor central livre.
- Somente o escritório; materiais em madeira, piso cinza quente, divisórias baixas e seis agentes.
- `index.html` contém o JavaScript completo e abre diretamente no navegador, sem internet ou servidor.
- Arraste para mudar levemente o ângulo, use a roda para aproximar e dê dois cliques para restaurar a vista.
- `scene.js` monta a planta e a câmera; `models.js` desenha a mobília e os personagens; `screens.js` desenha as telas.

## Plano de construção e verificação

1. Construir seis estações com monitor, teclado, gabinete, cadeira e agente.
2. Montar o U e enquadrar todas as telas com uma câmera frontal elevada.
3. Empacotar com o Three.js instalado no projeto: `node docs/mockups/agents/office-u-6pc/build.mjs`.
4. Abrir o HTML com Chromium, verificar seis monitores e capturar a vista em desktop e celular.
5. Conferir erros do navegador, abertura sem rede, movimento da câmera e restauração da vista.

O mockup não altera o escritório real do aplicativo.

## Verificação realizada

`node docs/mockups/agents/office-u-6pc/verify.mjs` confirmou a abertura offline, nenhuma requisição externa, nenhum erro do navegador, seis telas enquadradas e voltadas para a câmera em 1600 × 1000 e 390 × 844, giro com arraste e restauração por duplo clique. Capturas: `preview.png` e `preview-mobile.png`; relatório: `verification.json`.

`npm run typecheck` passou. `npm test` terminou com 5901 testes aprovados, 8 falhas, 86 ignorados e falhas de hooks/timeout em suítes do aplicativo. Nenhum arquivo de produção foi alterado por este mockup.
