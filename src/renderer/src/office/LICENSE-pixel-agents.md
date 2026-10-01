# Aviso de licença — pixel-agents

O motor do escritório em `engine/` deriva do projeto
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (pasta
`webview-ui/src/office/`, commit `3537e140c2094761beae748592aeb92ece8edfdd`),
distribuído sob a licença MIT reproduzida abaixo. O código foi copiado e
enxugado: ficaram de fora servidor, adaptadores, hooks, leitores de JSONL,
greeter, editor, carregamento de PNG, colorize, catálogo de móveis, pets, efeito
matrix, áreas e times. A arte não vem do pixel-agents — o renderer a recebe pela
interface `OfficeArt`.

## Arquivos derivados

| Arquivo deste projeto | Origem no pixel-agents |
| --- | --- |
| `engine/constants.ts` | `webview-ui/src/constants.ts` (subconjunto, reescalado de 16 px para 8 px) |
| `engine/types.ts` | `webview-ui/src/office/types.ts` |
| `engine/tileMap.ts` | `webview-ui/src/office/layout/tileMap.ts` |
| `engine/world.ts` | `webview-ui/src/office/layout/layoutSerializer.ts` e trechos de `engine/officeState.ts` |
| `engine/seatPlacement.ts` | `webview-ui/src/office/engine/seatPlacement.ts` |
| `engine/characters.ts` | `webview-ui/src/office/engine/characters.ts` |
| `engine/officeState.ts` | `webview-ui/src/office/engine/officeState.ts` |
| `engine/agents.ts` | `webview-ui/src/office/engine/officeState.ts` |
| `engine/subagents.ts` | `webview-ui/src/office/engine/officeState.ts` |
| `engine/bubbles.ts` | `webview-ui/src/office/engine/officeState.ts` |
| `engine/gameLoop.ts` | `webview-ui/src/office/engine/gameLoop.ts` |
| `engine/camera.ts` | `webview-ui/src/office/projection.ts` e `webview-ui/src/office/components/OfficeCanvas.tsx` |
| `engine/spriteCache.ts` | `webview-ui/src/office/sprites/spriteCache.ts` |
| `engine/sceneLayers.ts` | `webview-ui/src/office/engine/renderer.ts` |
| `engine/renderer.ts` | `webview-ui/src/office/engine/renderer.ts` |

## Texto da licença

```
MIT License

Copyright (c) 2026 Pablo De Lucca

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
