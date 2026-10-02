/**
 * Biblioteca de falas do Escritório 3D (PT-BR): por situação, um ícone e ≥ 4
 * moldes. Humor à vontade, mas sempre com o dado concreto — o molde carrega o
 * slot ({file}, {cmd}, {n}, {pct}…) que format.fill preenche e corta para caber
 * em 72. "[ … ]" é trecho opcional: some quando falta o dado de dentro.
 * {s} é o plural do número ao lado ("1 teste" / "42 testes") e nunca vai
 * dentro de "[ … ]". Sem slot só onde o próprio fato é o dado (voz ligou,
 * limite voltou, processo em segundo plano…), no `thought`, o pensamento à
 * toa, e nas frases da festa do apagão (party*), que só citam a hora da volta.
 * Energia (power-*): economia e alerta sempre com {pct}; o apagão, com {time}
 * (a hora em que a luz volta); a volta, com {pct}.
 *
 * Quem escolhe a situação, a variação e o tempo no ar é o generator.ts.
 */
import type { BashFlavor } from './format'

export type Situation =
  | 'request' | 'think'
  | 'edit' | 'write' | 'read' | 'search' | `bash-${BashFlavor}` | 'bash-peek'
  | 'web-search' | 'web-fetch' | 'web-browse' | 'task' | 'delegate' | 'other'
  | 'perm-cmd' | 'perm-file' | 'perm-question' | 'perm-tool' | 'perm-done'
  | 'error'
  | 'done-files' | 'done-file' | 'done-cmds' | 'done-chat'
  | 'test-pass' | 'test-fail' | 'test-none' | 'return-ok' | 'return-fail'
  | 'context-low' | 'stalled' | 'stalled-cmd' | 'usage-time' | 'usage-notime' | 'usage-back'
  | 'speak-on' | 'speak-off'
  | 'idle' | 'thought'
  | 'power-eco' | 'power-alert' | 'power-out' | 'power-back'
  | 'party' | 'party-flashlight' | 'party-pizza' | 'party-conga'

export interface SituationLines {
  readonly icon: string
  readonly lines: readonly string[]
}

const at = (icon: string, lines: readonly string[]): SituationLines => ({ icon, lines })

export const LINES: Readonly<Record<Situation, SituationLines>> = {
  // ── pedido e raciocínio ─────────────────────────────────────────────────
  request: at('💬', [
    "Opa, pedido novo: '{text}' — bora!",
    "Chegou pedido: '{text}'. Arregaçando as mangas 💪",
    "Anotado: '{text}'. Deixa comigo!",
    "Missão recebida: '{text}' 🫡",
    "'{text}'? É pra já! 🏃",
    "Pedido na mesa: '{text}'. Partiu!"
  ]),
  think: at('🧠', [
    "Matutando[ sobre '{text}']… 🤔",
    "Bolando o plano[ pra '{text}'] 📐",
    "Pensando[ em '{text}']. Sai fumacinha 💨",
    "Organizando as ideias[: '{text}']",
    "Quebrando a cabeça[ com '{text}'] 🧩"
  ]),

  // ── ferramentas ─────────────────────────────────────────────────────────
  edit: at('✏️', [
    'Mexendo no {file}[ ({diff})]. Respira, {ext}.',
    'Editando {file}[ ({diff})] com todo carinho',
    'Cirurgia no {file}[ ({diff})]. Bisturi! 🩺',
    'Ajustando {file}[ ({diff})]. Sem quebrar nada… espero',
    'Dando um tapa no {file}[ ({diff})] 💅'
  ]),
  write: at('📝', [
    'Criando o {file} do zero ✨',
    'Escrevendo {file} inteirinho. Folha em branco dá medo',
    'Nasceu um arquivo: {file} 🐣',
    'Gerando {file}. Cheirinho de arquivo novo'
  ]),
  read: at('📖', [
    'Lendo {file}… quem escreveu isso? Ah, fui eu.',
    'Dando uma lida no {file}. Sem spoiler!',
    'Estudando o {file} com lupa 🧐',
    'Abrindo {file} pra entender o rolê',
    'Leitura dinâmica no {file} 🤓'
  ]),
  search: at('🔦', [
    "Caçando '{pattern}' pelo projeto 🔎",
    "Procurando '{pattern}'[ em {dir}]. Cadê você? 👀",
    "Revirando o código atrás de '{pattern}'",
    "Grep na veia: '{pattern}'[ em {dir}]",
    "Onde se meteu '{pattern}'? Tô achando…"
  ]),
  'bash-test': at('🧪', [
    'Rodando {cmd}. Dedos cruzados 🤞',
    '{cmd}… que os testes estejam conosco 🙏',
    'Hora da verdade: {cmd}',
    'Rodando {cmd}. Se ficar vermelho, eu não vi 🙈',
    '{cmd} no forno. Torcendo pelo verde 💚'
  ]),
  'bash-install': at('📦', [
    '{cmd}… dá tempo de um café ☕',
    'Baixando meia internet: {cmd}',
    'Dependências a caminho: {cmd} 🚚',
    'Instalando: {cmd}. Paciência, jovem 🧘'
  ]),
  'bash-build': at('🏗️', [
    'Compilando: {cmd}. Segura que vem!',
    '{cmd}… se passar de primeira, eu pago o café',
    'Montando o build: {cmd} 🔧',
    'Build no forno: {cmd}. Cheiro de bundle novo'
  ]),
  'bash-check': at('🧹', [
    '{cmd}: caçando tipo torto',
    'Pente-fino: {cmd}. Nenhum any escapa 🔍',
    '{cmd}… o compilador vai me julgar 😅',
    'Conferindo a casa com {cmd}'
  ]),
  'bash-git': at('🌿', [
    '{cmd}: vamos ver o estrago',
    'Batendo um papo com o Git: {cmd}',
    '{cmd}… o histórico não mente 📜',
    'Git na área: {cmd}. Sem force push, juro'
  ]),
  'bash-serve': at('🚀', [
    'Subindo o app: {cmd}',
    '{cmd}… ligando os motores 🏁',
    'Servidor de pé com {cmd}? Vamos ver',
    'Dando a partida: {cmd} 🔑'
  ]),
  'bash-run': at('⌨️', [
    'Rodando `{cmd}` no terminal',
    'Terminal, faça sua mágica: `{cmd}` 🪄',
    'Executando `{cmd}`. Confia 😎',
    'Mandando ver: `{cmd}`',
    '`{cmd}`… digitado com convicção'
  ]),
  'bash-peek': at('⌨️', [
    'Espiando a saída do terminal 👀',
    'Conferindo o que o terminal aprontou 🕵️',
    'De olho no processo em segundo plano',
    'Cutucando o processo em segundo plano ⚙️'
  ]),
  'web-search': at('🌐', [
    "Pesquisando '{q}' na web (sem abrir meme, prometo)",
    "Googlando '{q}'… digo, pesquisando 😇",
    "Perguntando pra internet: '{q}'",
    "Busca na web: '{q}'. Já volto com a resposta"
  ]),
  'web-fetch': at('🌐', [
    'Lendo {host}. Só o essencial, juro',
    'Visitando {host} (sem aceitar cookies 🍪)',
    'Dando um pulinho em {host}',
    'Abrindo {host} pra conferir umas coisas 🔗'
  ]),
  'web-browse': at('🧭', [
    'No navegador: {action} 🖱️',
    'Pilotando o navegador: {action}',
    'Navegador na mão, {action}',
    'Agora: {action} no navegador. Robô navegando 🤖'
  ]),
  task: at('🤝', [
    "Chamei o {who}[: '{desc}']",
    "Passando a bola pro {who}[: '{desc}'] ⚽",
    "Delegando pro {who}[: '{desc}']. Confio!",
    "Reforço convocado: {who}[ → '{desc}'] 📣"
  ]),
  delegate: at('🤝', [
    "Escalei o {who}[ pra '{desc}'] 📋",
    "O {who} entrou em campo[: '{desc}'] ⚽",
    "Bora, {who}![ Missão: '{desc}']",
    "Time reforçado: {who}[ cuida de '{desc}']"
  ]),
  other: at('🛠️', [
    'Usando {tool}. Ferramenta certa pro serviço',
    'Acionando {tool}… 🔧',
    'Hora de usar {tool} ⚙️',
    'Puxando {tool} da caixa de ferramentas 🧰'
  ]),

  // ── permissão ───────────────────────────────────────────────────────────
  'perm-cmd': at('✋', [
    'Posso rodar `{cmd}`? Clica em mim 🙋',
    'Preciso do seu ok pra `{cmd}`',
    'Libera `{cmd}`? Prometo juízo 🤞',
    '`{cmd}` aguarda sua bênção. Clica aqui 🙏'
  ]),
  'perm-file': at('✋', [
    'Posso mexer no {file}? Clica em mim 🙋',
    'Libera eu editar o {file}?',
    'Preciso de permissão pro {file}. Clica aqui 🔑',
    '{file} tá trancado pra mim. Abre? 🚪'
  ]),
  'perm-question': at('❓', [
    "Pergunta pra você: '{q}' Clica aqui 🙋",
    "Me ajuda a decidir: '{q}'",
    "Dúvida cruel: '{q}' 🤔",
    "Sua vez: '{q}'"
  ]),
  'perm-tool': at('✋', [
    'Posso usar {tool}[ ({what})]? Clica em mim 🙋',
    'Libera o {tool}[ pra {what}]?',
    '{tool}[ ({what})] precisa do seu ok 🔑',
    'Pedindo licença pra usar {tool}[: {what}] 🙏'
  ]),
  'perm-done': at('👍', [
    'Valeu pela resposta[ sobre {what}]! Seguindo 🫡',
    'Respondido[: {what}]. Bola pra frente ⚽',
    'Decisão anotada[ sobre {what}]. Continuando',
    'Recebido[: {what}]! De volta ao batente'
  ]),

  // ── erro ────────────────────────────────────────────────────────────────
  error: at('💥', [
    'Deu ruim: {err}. Bora investigar? 🔍',
    'Tropecei: {err} 🤕',
    'Erro na área: {err}. Clica pra ver',
    'Ops… {err}. Culpa do computador, claro',
    'Travei em {err}. Me dá uma luz? 💡'
  ]),

  // ── resultados ──────────────────────────────────────────────────────────
  'done-files': at('✅', [
    'Pronto! {n} arquivos editados. Dá uma olhada 👀',
    'Feito: {n} arquivos mexidos. Revisa aí?',
    'Missão cumprida! {n} arquivos no capricho',
    'Terminei! {n} arquivos alterados. Confere? 🧐'
  ]),
  'done-file': at('✅', [
    'Pronto! Mexi no {file}. Dá uma olhada 👀',
    'Feito: {file} atualizado. Confere?',
    'Terminei o {file}. Ficou bonito, vai 💅',
    '{file} no capricho. Pode conferir!'
  ]),
  'done-cmds': at('✅', [
    'Pronto! Rodei `{cmd}`[ e mais {more}] 🏁',
    'Feito: `{cmd}`[ +{more}] executado',
    'Terminei de rodar `{cmd}`[ e mais {more}]',
    'Missão cumprida com `{cmd}`[ (+{more})] 🫡'
  ]),
  'done-chat': at('✅', [
    "Respondido[: '{text}']. Próximo! 🙌",
    "Feito[: '{text}']. Resposta no chat 💬",
    "Terminei[ '{text}']! Saindo do forno 🍞",
    "Prontinho[: '{text}']. Dá uma olhada 👀"
  ]),
  'test-pass': at('🧪', [
    '{n} teste{s} verde{s}! ✅ Pode confiar.',
    'Tudo verde: {n} teste{s} passando 💚',
    '{n} teste{s} ok. Hoje não, bug! 🐛',
    'Passou geral: {n} de {n}. Tira print 📸'
  ]),
  'test-fail': at('🧪', [
    '{n} teste{s} vermelho{s}. Já vou consertar 😬',
    '{n} de {total} falhando. Respira e conserta',
    '{n} falha{s} nos testes. Bora caçar o bug 🐛',
    'Vermelhou: {n} de {total}. Nada que um café não resolva ☕'
  ]),
  'test-none': at('🧪', [
    'Rodei os testes e… nenhum contou 🤷',
    'Testes rodaram, mas zero resultado. Suspeito 🕵️',
    'Nenhum teste passou nem falhou. Mistério',
    '0 testes? O filtro foi forte demais 😅'
  ]),
  'return-ok': at('📦', [
    'O {who} voltou: missão cumprida ✅',
    'Valeu, {who}! Entrega recebida',
    'O {who} terminou a parte dele 👏',
    'Relatório do {who} na mão. Seguindo!'
  ]),
  'return-fail': at('📦', [
    'O {who} voltou com erro. Vou ver o que houve 😬',
    'Deu ruim pro {who}. Assumo daqui',
    'O {who} tropeçou. Hora do plano B 🛟',
    'O {who} voltou de mãos vazias 🫠'
  ]),

  // ── avisos ──────────────────────────────────────────────────────────────
  'context-low': at('🔋', [
    'Memória em {pct}%… já já compacto 🧠',
    'Contexto em {pct}%. Tô esquecendo até meu nome',
    'Só {pct}% de contexto. Hora de resumir a novela 📝',
    'Bateria do contexto em {pct}% 🪫'
  ]),
  stalled: at('⏱️', [
    'Sem sinal de vida há {dur}… ⏳',
    'Há {dur} sem resposta. Alguém viu meu processo?',
    '{dur} de silêncio. Constrangedor 😶',
    'Esperando há {dur}. Paciência de monge 🧘'
  ]),
  'stalled-cmd': at('⏱️', [
    'Esse comando tá há {dur}… ⏳',
    '`{cmd}` rodando há {dur}. Paciência de monge 🧘',
    '{dur} esperando `{cmd}`. Vou pegar um café ☕',
    '`{cmd}` tá pensativo há {dur} 🐢'
  ]),
  'usage-time': at('⛽', [
    'Limite da sessão estourou. Café até {time} ☕',
    'Cota zerada. Volto a partir de {time} 😴',
    'Sem crédito até {time}. Hora do intervalo 🏖️',
    'Reset do limite: {time}. Até lá, cafezinho'
  ]),
  'usage-notime': at('⛽', [
    'Limite da sessão estourou. Sem hora pra voltar ☕',
    'Cota zerada! Esperando o reset 😴',
    'Bati no limite de uso. Pausa forçada 🛑',
    'Acabou o crédito por ora. Cochilo autorizado 💤'
  ]),
  'usage-back': at('⚡', [
    'Limite liberado! De volta ao batente 💪',
    'Cota renovada. Partiu trabalhar! 🚀',
    'Voltei! O limite resetou',
    'Crédito de volta. Que saudade de trabalhar 😄'
  ]),

  // ── voz ─────────────────────────────────────────────────────────────────
  'speak-on': at('🔊', [
    'Lendo a resposta em voz alta',
    "Narrando a resposta[ de '{text}'] 🎙️",
    'Aumenta o som: tô lendo a resposta 📢',
    'Modo locutor: lendo a resposta 📻'
  ]),
  'speak-off': at('🔇', [
    'Fim da leitura. Microfone desligado 🎤',
    'Pronto, falei! Voz em repouso 🤐',
    'Leitura encerrada. Obrigado, obrigado 🙇',
    'Parei de ler. Silêncio na sala 🤫'
  ]),

  // ── à toa ───────────────────────────────────────────────────────────────
  idle: at('💤', [
    'Sem tarefa[ há {ago}]… vou regar a planta 🌱',
    'Parado[ há {ago}]. Alguém tem um bug pra mim? 🐛',
    'De folga[ há {ago}]. Bom demais pra ser verdade',
    'Esperando pedido[ há {ago}]. Me chama! 📞',
    'Ocioso[ há {ago}]. Contando pixels no teto'
  ]),
  thought: at('💭', [
    'E se eu reescrever tudo em Rust? 🦀',
    'Funciona na minha máquina. Isso conta, né?',
    'Será que o bug tá no cache? Sempre é o cache',
    'Hoje é sexta? Melhor não fazer deploy 🙅',
    'Um dia eu ainda entendo regex de primeira',
    'Café: o verdadeiro compilador do time ☕',
    '99 bugs no código… conserta um… 127 bugs no código 🎶',
    'Dark mode não é tema, é estilo de vida 🌙',
    'Compilou de primeira? Desconfia 🤨',
    'Tabs ou espaços? Melhor nem começar…',
    'TODO: lembrar o que era esse TODO',
    'git blame… ah não, fui eu de novo 🙈',
    'Documentação? Eu sou a documentação 😎',
    'O teste passou. Agora desconfio do teste',
    'Será que resolve com mais um useEffect? 🤔',
    'Dar nome a variável: o maior desafio da computação',
    'Quando eu crescer, quero ser um PR aprovado',
    'Não é bug, é feature surpresa ✨',
    'Quem deixou esse console.log aqui? Ah, eu',
    'Off-by-one: o erro que eu cometo uma vez a cada… duas'
  ]),

  // ── energia do escritório (tokens da sessão de 5h) ─────────────────────
  'power-eco': at('🌱', [
    'Energia em {pct}%. Apaga a luz do corredor aí 💡',
    'Modo economia: {pct}% de tokens. Meia luz, meio café 🌱',
    '{pct}% na bateria do escritório. Desliga um abajur aí 🔌',
    'Economizando: {pct}% até o reset[ das {time}] 🧮',
    'Só {pct}% de energia. Quem deixou o monitor aceso? 👀'
  ]),
  'power-alert': at('⚠️', [
    'Bateria do escritório em {pct}%![ Reseta às {time}] ⚠️',
    'Alerta: {pct}% de tokens. Salvem seus arquivos! 💾',
    '{pct}% e piscando… isso não é efeito especial 😬',
    'Energia em {pct}%. Vai faltar luz[ até {time}] 🕯️',
    'Giroflex ligado: {pct}% na usina[, reset às {time}] 🚨'
  ]),
  'power-out': at('🕺', [
    'Acabou a luz! Festa[ até {time}] 🕺',
    'Sem tokens, sem trabalho. Solta o som, DJ![ Até {time}] 🎶',
    'Quem pisou no cabo? 🔦[ Volta às {time}]',
    'Apagão! Os tokens acabaram[, luz de volta às {time}] 🕯️',
    'Escritório sem energia[ até {time}]. Partiu pista! 💃'
  ]),
  'power-back': at('💡', [
    'Voltou a luz! {pct}% de energia. Todo mundo pra mesa 🏃',
    'Luz de volta, {pct}% na bateria! Acabou a festa 🛑',
    'Energia renovada: {pct}%. Desliga o globo! 💡',
    'O disjuntor voltou! {pct}% de tokens, bora trabalhar 💪',
    'Reset feito: {pct}% de energia. Cadeira, me espera! 💺'
  ]),

  // ── festa no apagão (frases rotativas, 1–2 por vez) ─────────────────────
  party: at('🎉', [
    'DJ, solta o grave! 🔊',
    'Esse é o meu passo do robô 🤖',
    'Sem tokens, sem deploy. Só dança 💃',
    'Ninguém me julga: está escuro 🕺',
    'Isso conta como hora extra? 🎉',
    'Bola de discoteca: melhor compra do ano ✨',
    'Quando a luz voltar, eu estava trabalhando, ok? 🤫',
    'Festa no escritório[ até {time}]! 🥳',
    'Pista lotada! Cuidado com o cabo ⚡',
    'Mais uma, DJ![ O reset é só às {time}] 🎶',
    'Sem luz, mas com estilo ✨',
    'Alguém viu meu teclado? Tava aqui 🎹'
  ]),
  'party-flashlight': at('🔦', [
    'Cadê o disjuntor? 🔦',
    'Achei! …não, é a cafeteira ☕',
    'Disjuntor, aparece! Prometo não te desligar 🔦',
    'Lanterna na mão, esperança no coração 🔦',
    'Procurando o disjuntor[ até {time}], se precisar 🕵️'
  ]),
  'party-pizza': at('🍕', [
    'Sem tokens, mas com pizza 🍕',
    'Quem pediu calabresa? 🍕',
    'Pizza no escuro tem mais sabor 🍕',
    'Pausa forçada = pizza. Regras são regras 🍕',
    'Essa fatia é minha[ até {time}] 🍕'
  ]),
  'party-conga': at('🚂', [
    'Olha o trenzinho! Piuí! 🚂',
    'Conga, conga, conga! 💃',
    'Segura no ombro e vai! 🚃',
    'Trenzinho do apagão[, última parada às {time}] 🚂',
    'Próxima estação: pista de dança 🚉'
  ])
}
