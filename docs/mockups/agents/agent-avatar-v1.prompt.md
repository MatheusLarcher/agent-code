# Guia de avatares para o escritório do Agent Code

Os agentes devem ter identidades próprias e roupas adequadas à sua função. Todos devem compartilhar a qualidade de textura, o estilo 3D cartoon e o acabamento do avatar de referência.

## Referência visual

Use `agent-avatar-v1.png`, nesta mesma pasta, como referência de qualidade e acabamento ao gerar novos personagens. O primeiro avatar foi gerado com a ferramenta integrada imagegen, em PNG de 1024 x 1536 pixels com canal alfa.

O rosto, o cabelo, a roupa azul e o tênis desse avatar são escolhas daquele personagem. Os novos agentes podem ter outras aparências, roupas e cores.

## Qualidade comum a todos os agentes

- Renderização 3D cartoon refinada, com formas suaves, anatomia estilizada coerente e rosto expressivo.
- Texturas modernas e detalhadas: trama dos tecidos, costuras, dobras, acabamento dos calçados e cabelo esculpido com volume.
- Materiais convincentes para cada roupa: malha para suéteres, tecido de alfaiataria para ternos e materiais adequados para os acessórios e calçados escolhidos.
- Pele com acabamento suave, iluminação difusa de estúdio, volume e oclusão ambiente discretos.
- Mesmo padrão de qualidade, nitidez, perspectiva e escala visual, para que todos pertençam ao mesmo escritório.

## Identidade e roupa conforme a função

Varie rosto, cabelo, tom de pele, gênero, idade adulta, silhueta, expressão e paleta de roupa entre os personagens. Cada agente deve ser reconhecível individualmente. Preserve a identidade escolhida caso sejam geradas outras poses do mesmo agente.

Escolha a roupa a partir da função informada. Ternos, blazers, camisas sociais, vestidos, roupas casuais ou uniformes são permitidos quando fizerem sentido para o personagem. Os exemplos abaixo são orientações, não um catálogo obrigatório:

| Função | Exemplos de roupa |
| --- | --- |
| Desenvolvimento | Suéter, camiseta ou camisa casual; calça e tênis |
| Gestão ou direção | Terno, conjunto de alfaiataria ou blazer; sapato social |
| Financeiro ou análise | Camisa social, blazer ou roupa profissional casual |
| Design ou criação | Roupa contemporânea, com escolhas próprias de cores e acessórios |
| Atendimento ou comercial | Roupa profissional adequada ao público e à função |
| Operações | Roupa prática ou uniforme, se a função justificar |

## Entrega de cada avatar

Gere um personagem por imagem. Para a pose inicial, use corpo inteiro em pé, postura relaxada, vista frontal em três quartos e câmera levemente elevada. Mantenha cabeça e calçados inteiros, margem ao redor da silhueta e enquadramento consistente entre os agentes.

Entregue PNG de 1024 x 1536 pixels com fundo realmente transparente. Sem cenário, plataforma, mobiliário, texto ou marca-d'água. Esta entrega é uma imagem estática de avatar.

## Modelo de prompt para novos personagens

Preencha função, aparência e roupa para cada agente e forneça o PNG de referência à ferramenta de geração de imagens.

```text
Crie um único avatar humano de corpo inteiro para o escritório virtual do Agent Code.
Função do agente: {função}.
Identidade e aparência: {aparência própria desse personagem}.
Roupa: {roupa adequada à função; pode incluir terno ou alfaiataria}.
Use a imagem de referência para manter a qualidade das texturas e o acabamento 3D cartoon.
Mantenha identidade própria, com rosto, cabelo, silhueta e roupa definidos para este agente.
Renderize tecidos com trama, costuras e dobras refinadas; materiais adequados a cada peça;
pele suave, cabelo com volume e iluminação difusa de estúdio.
Corpo inteiro em pé, pose relaxada, vista frontal em três quartos, câmera levemente elevada.
Mesma perspectiva e escala visual da referência, sem cortar cabeça ou calçados.
PNG de 1024 x 1536 pixels, fundo transparente, um personagem por imagem.
Sem cenário, mobiliário, plataforma, texto ou marca-d'água.
```

## Prompt utilizado no primeiro avatar

Registro da geração de `agent-avatar-v1.png`. A aparência específica descrita abaixo é um exemplo; para novos agentes, use as orientações e o modelo de prompt acima.

Use case: stylized-concept.
Asset type: a single isolated avatar mockup for the Agent Code virtual agents office.
Create ONE full-body adult male human office agent character, alone, as a polished premium 3D cartoon miniature. Match the visual qualities of the supplied reference concept: softly sculpted human anatomy, tasteful stylization rather than exaggerated caricature, convincing modern material textures, beautiful soft studio lighting, and the visual finish of a high-quality 3D diorama. The reference shows casually dressed human miniatures with brown hair, blue clothing, natural proportions, white sneakers, and finely rendered materials. Only its avatar rendering quality and style are relevant.
Subject: friendly young adult man, short neatly sculpted dark brown hair, subtle warm smile, expressive brown eyes, softly stylized face and natural hands. Wear a modern medium-blue crewneck sweater with fine knitted textile texture and clean cuffs, charcoal tapered trousers with restrained fabric weave and realistic cartoon folds, and clean off-white sneakers with modeled soles. Professional casual look suitable for a developer working in a virtual office.
Composition: one character standing in a relaxed neutral pose, arms resting at sides with a small natural gap from the torso, both empty hands visible, feet comfortably separated. Three-quarter front view, camera very slightly elevated like a virtual office game character, entire body visible from hair to soles, centered with modest clear padding around the silhouette. Keep the face clearly readable. One portrait-oriented high-resolution image.
Rendering: rounded polished shapes, soft matte skin with subtle subsurface scattering, fine modern cloth textures, individually readable sculpted hair locks, physically coherent materials, premium animated-film quality, sharp clean edges, soft ambient occlusion within the character, gently diffused key light and restrained fill.
Backdrop: genuine transparent alpha background. No floor, no platform, no ground plane, no scenery, no cast shadow outside the character. This is a reusable standalone avatar cutout.
Constraints: exactly ONE character and ONE view. No desk, office furniture, laptop, trees, paths, accessories, other characters, frames, labels, logos, text, watermark, or reference-image layout. No robot, helmet, chibi proportions, flat 2D illustration, pixel art, or photorealistic skin. Produce only the finished avatar image.
