// Banco de fatos de MENTIRA para o acervo caótico (gerar-acervo-caotico.mjs).
// Cada tema tem fatos; cada fato tem o texto da memória e três jeitos de perguntar por ele:
//   d = direto (com as palavras da memória) · p = paráfrase (sem as palavras-chave)
//   e = com erro de digitação / gíria / abreviação
// Temas parecidos de propósito (horta-app × horta-comunitaria, padaria × confeitaria,
// clinica-vet × petshop) para medir confusão entre temas.
export const TEMAS = {
  'padaria': [
    { t: 'Padaria Pão Quente abre às 6h e fecha às 20h; domingo abre às 7h', d: 'que horas a Padaria Pão Quente abre no domingo', p: 'em que horário o estabelecimento de pães começa a funcionar no fim de semana', e: 'q hrs abre a padaria domingo' },
    { t: 'Cores do site da padaria: marrom #6B3E26 e creme #F5E6C8', d: 'quais as cores do site da padaria', p: 'qual a paleta usada na página da loja de pães', e: 'cores do sait da padaria' },
    { t: 'Pedidos da padaria chegam pelo WhatsApp com o carrinho preenchido', d: 'como chegam os pedidos da padaria no WhatsApp', p: 'por qual app de mensagem os clientes da loja de pães encomendam', e: 'pedido padaria zap' },
    { t: 'Pão francês custa R$ 0,90 e o preço muda toda segunda-feira', d: 'quanto custa o pão francês da padaria', p: 'qual o valor da unidade do pãozinho de sal', e: 'preco do paozinho' }
  ],
  'confeitaria': [
    { t: 'Confeitaria Doce Lar faz bolo de casamento só com 30 dias de antecedência', d: 'com quanta antecedência a Confeitaria Doce Lar aceita bolo de casamento', p: 'qual o prazo mínimo para encomendar um bolo de noiva', e: 'prazo bolo casamento confeitaria' },
    { t: 'Site da confeitaria usa a fonte Playfair Display nos títulos', d: 'qual fonte o site da confeitaria usa nos títulos', p: 'que tipografia aparece nos cabeçalhos da página de doces', e: 'fonte titulo confeitaria' },
    { t: 'Confeitaria não entrega aos domingos; retirada só no balcão', d: 'a confeitaria entrega no domingo', p: 'tem como receber os doces em casa no último dia da semana', e: 'confeitaria entrega dmg?' }
  ],
  'horta-app': [
    { t: 'App Horta Fácil manda aviso de rega às 7h pelo Firebase Cloud Messaging', d: 'que horas o Horta Fácil manda o aviso de rega', p: 'quando o aplicativo das plantas lembra o usuário de molhar', e: 'notificacao de rega do app horta' },
    { t: 'Login do Horta Fácil usa Google Sign-In; erro 10 é SHA-1 errado no console', d: 'o login com Google do Horta Fácil dá erro 10', p: 'a entrada com a conta do Google no aplicativo de plantas falha com código 10', e: 'erro 10 login google horta' },
    { t: 'Banco do Horta Fácil é Postgres com tabela canteiros indexada por usuario_id', d: 'como é o banco do Horta Fácil', p: 'onde o aplicativo das plantas guarda as informações dos canteiros', e: 'bd do horta facil lento' },
    { t: 'Publicar o Horta Fácil: AAB assinado na faixa interna, esperar 24h, depois produção', d: 'como publicar o Horta Fácil na Play Store', p: 'qual o passo a passo para lançar a nova versão do aplicativo de plantas na loja do Android', e: 'subir horta na play store' }
  ],
  'horta-comunitaria': [
    { t: 'Horta comunitária da Rua das Flores tem mutirão todo sábado às 8h', d: 'quando é o mutirão da horta comunitária', p: 'que dia os vizinhos se juntam para cuidar do terreno de plantio do bairro', e: 'mutirao horta da rua' },
    { t: 'Horta comunitária guarda as ferramentas no galpão; a chave fica com a dona Neide', d: 'onde ficam as ferramentas da horta comunitária', p: 'com quem está a chave do depósito das enxadas do bairro', e: 'chave galpao horta' },
    { t: 'Rega da horta comunitária é por gotejamento ligado às 6h no timer', d: 'como funciona a rega da horta comunitária', p: 'de que jeito as plantas do terreno coletivo recebem água', e: 'rega da horta do bairro' }
  ],
  'clinica-vet': [
    { t: 'Clínica veterinária Patas atende emergência 24h no número fixo 3333-1010', d: 'qual o telefone de emergência da clínica Patas', p: 'para onde ligar se o cachorro passar mal de madrugada', e: 'tel emergencia vet patas' },
    { t: 'Vacina V10 do cachorro reforça todo ano em março na clínica Patas', d: 'quando reforçar a vacina V10 do cachorro', p: 'em que mês o cão toma de novo a dose anual', e: 'vacina v10 dog' },
    { t: 'Sistema da clínica Patas exporta prontuário em PDF pelo botão Imprimir', d: 'como exportar prontuário da clínica Patas em PDF', p: 'de que jeito tirar o histórico do animal do sistema em documento', e: 'exportar prontuario pdf clinica' }
  ],
  'petshop': [
    { t: 'Petshop Bicho Feliz faz banho e tosa com agendamento pelo Instagram', d: 'como agendar banho e tosa no Petshop Bicho Feliz', p: 'por onde marcar o banho do bichinho na loja de animais', e: 'agendar banho tosa pet' },
    { t: 'Ração do gato é a Golden castrados 10 kg, comprada no Bicho Feliz', d: 'qual ração do gato compramos no petshop', p: 'que comida o felino come e onde a gente compra', e: 'racao do gato' }
  ],
  'oficina': [
    { t: 'Oficina do Zé troca óleo do carro a cada 10 mil km com óleo 5W30', d: 'de quanto em quanto km trocar o óleo na Oficina do Zé', p: 'qual o intervalo para fazer a manutenção do lubrificante do motor', e: 'troca de oleo carro km' },
    { t: 'Freio do carro rangendo: a oficina disse que é pastilha, troca orçada em R$ 380', d: 'quanto custa trocar a pastilha de freio na oficina', p: 'qual foi o orçamento para o barulho na hora de parar o veículo', e: 'orcamento freio rangendo' }
  ],
  'condominio': [
    { t: 'Condomínio Solar: taxa de R$ 520 vence dia 10; boleto pelo app Superlógica', d: 'quando vence a taxa do condomínio Solar', p: 'qual a data do pagamento mensal do prédio', e: 'vencimento condominio' },
    { t: 'Reserva do salão de festas do condomínio é pelo app, com 15 dias de antecedência', d: 'como reservar o salão de festas do condomínio', p: 'de que jeito garantir o espaço de eventos do prédio para um aniversário', e: 'reservar salao predio' },
    { t: 'Síndico do condomínio Solar é o seu Carlos, apto 302', d: 'quem é o síndico do condomínio', p: 'quem administra o prédio e onde ele mora', e: 'sindico do predio' }
  ],
  'eleicoes': [
    { t: 'Equipe da campanha usa a planilha zonas-bairros para cruzar votos por bairro', d: 'qual planilha cruza votos por bairro na campanha', p: 'que arquivo a equipe usa para ver o resultado por região da cidade', e: 'planilha zona bairro votos' },
    { t: 'Dados do TSE baixados em CSV por seção eleitoral, encoding latin-1', d: 'em que formato vêm os dados do TSE', p: 'como o tribunal disponibiliza os resultados das urnas para download', e: 'csv tse encoding' }
  ],
  'escola': [
    { t: 'Reunião de pais da escola do Pedro é toda primeira quinta do mês às 19h', d: 'quando é a reunião de pais da escola do Pedro', p: 'que dia os responsáveis se encontram com a professora do menino', e: 'reuniao pais escola pedro' },
    { t: 'Uniforme da escola: camiseta azul, compra só na papelaria Lápis de Cor', d: 'onde comprar o uniforme da escola', p: 'em que loja tem a roupa obrigatória do colégio', e: 'uniforme escola onde compra' }
  ],
  'academia': [
    { t: 'Treino A da academia: peito e tríceps, 4 séries de 10, segunda e quinta', d: 'qual o treino A da academia', p: 'que músculos trabalho no começo da semana na musculação', e: 'treino a academia' },
    { t: 'Academia Força Total cobra R$ 99 no plano anual, cancelamento com 30 dias', d: 'quanto custa o plano anual da Academia Força Total', p: 'qual o valor da mensalidade no contrato de um ano da musculação', e: 'preco academia anual' }
  ],
  'contabilidade': [
    { t: 'Imposto do MEI (DAS) vence dia 20; guia gerada no portal do Simples Nacional', d: 'quando vence o DAS do MEI', p: 'qual a data limite do tributo mensal do microempreendedor', e: 'das mei vencimento' },
    { t: 'Contadora Márcia pede as notas fiscais até o dia 5 de cada mês por e-mail', d: 'até quando mandar as notas fiscais para a contadora', p: 'qual o prazo para enviar os comprovantes de venda para quem cuida dos impostos', e: 'nota fiscal contadora prazo' }
  ],
  'viagem': [
    { t: 'Viagem para Gramado em julho: pousada Bela Vista reservada de 10 a 14', d: 'quais as datas da pousada em Gramado', p: 'em que dias ficamos hospedados na serra gaúcha nas férias de inverno', e: 'pousada gramado datas' },
    { t: 'Passagem para Gramado: voo até Porto Alegre e carro alugado na Localiza', d: 'como vamos chegar em Gramado', p: 'qual o transporte combinado até a cidade do chocolate', e: 'como ir pra gramado' }
  ],
  'ong': [
    { t: 'ONG Mãos Dadas presta contas ao edital até 30/11 com relatório e fotos', d: 'qual o prazo da prestação de contas do edital da ONG', p: 'até quando a associação precisa entregar o relatório do financiamento', e: 'prestacao contas edital ong' },
    { t: 'Doações da ONG entram pela chave PIX do CNPJ; recibo enviado em até 48h', d: 'como recebemos doações na ONG', p: 'de que forma as pessoas contribuem com dinheiro para a associação', e: 'pix doacao ong' }
  ],
  'devops': [
    { t: 'Deploy do sistema é pelo GitHub Actions na branch main; staging na branch develop', d: 'como é o deploy do sistema', p: 'de que jeito o código vai para o servidor depois do merge', e: 'deploy gh actions main' },
    { t: 'Banco de produção é Postgres no Neon; backup diário às 3h', d: 'onde fica o banco de produção', p: 'em que serviço na nuvem estão os dados reais do sistema', e: 'bd prod onde fica' },
    { t: 'Docker do projeto sobe com docker compose up; porta 5432 ocupada = Postgres local ligado', d: 'o docker compose falha com porta 5432 ocupada', p: 'o ambiente em contêiner não inicia porque a porta do banco já está em uso', e: 'docker porta 5432 em uso' }
  ],
  'frontend': [
    { t: 'Botões do sistema usam o componente Button do design system, nunca botão nativo', d: 'qual componente usar para botão no sistema', p: 'como criar um elemento clicável seguindo o padrão visual da empresa', e: 'componente botao ds' },
    { t: 'Tela de login: cartão de 540px, campos altos e aviso de Caps Lock', d: 'como é a tela de login do sistema', p: 'qual o layout da página de entrada com usuário e senha', e: 'layout tela login' }
  ],
  'saude': [
    { t: 'Remédio da pressão: losartana 50 mg uma vez ao dia de manhã', d: 'qual remédio de pressão eu tomo', p: 'que medicamento uso para controlar a hipertensão e em que horário', e: 'remedio pressao' },
    { t: 'Dentista Dra. Lúcia: limpeza a cada 6 meses, próxima em janeiro', d: 'quando é a próxima limpeza no dentista', p: 'em que mês volto na Dra. Lúcia para tirar o tártaro', e: 'proxima limpeza dentista' }
  ],
  'banda': [
    { t: 'Banda ensaia no estúdio Som Livre às terças, 20h, sala 2', d: 'quando a banda ensaia no estúdio', p: 'que dia e onde o grupo de música se reúne para tocar', e: 'ensaio banda terca' },
    { t: 'Repertório do show tem 14 músicas e abre com Tempo Perdido', d: 'qual música abre o show da banda', p: 'com que canção começamos a apresentação', e: 'musica abertura show' }
  ],
  'podcast': [
    { t: 'Podcast grava às quartas com microfone Shure SM58; edição no Audacity', d: 'com que microfone gravamos o podcast', p: 'que equipamento de áudio uso no programa semanal', e: 'microfone podcast' },
    { t: 'Episódios do podcast saem no Spotify toda sexta às 9h', d: 'quando sai episódio novo do podcast', p: 'que dia e hora o programa de áudio é publicado', e: 'episodio podcast sai quando' }
  ],
  'mudanca': [
    { t: 'Mudança para o apartamento novo dia 15; caminhão da Leva Tudo às 7h', d: 'quando é a mudança e qual empresa', p: 'que dia vamos para a casa nova e quem leva os móveis', e: 'mudanca dia caminhao' },
    { t: 'Internet do apartamento novo: fibra da Vivo, instalação marcada para dia 16', d: 'quando instalam a internet no apartamento novo', p: 'que dia chega a conexão de fibra na casa para onde vamos', e: 'internet ap novo' }
  ]
}

/** Notas soltas da vida e de tecnologia, sem tema certo: distraem a busca. */
export const RUIDO = [
  'Lembrar de comprar pilha AA', 'Ideia: aplicativo de lista de compras compartilhada', 'Senha do Wi-Fi da casa fica no cofre',
  'Ver depois aquele vídeo sobre produtividade', 'git rebase -i para juntar commits', 'CSS: usar gap em vez de margin no flex',
  'Café coado rende mais que expresso', 'Ligar para a operadora sobre a fatura', 'Livro: Hábitos Atômicos, capítulo 3',
  'npm ci é mais rápido que npm install no CI', 'Regar as plantas da varanda', 'Aniversário da tia em agosto',
  'Revisar a planilha de gastos do mês', 'Testar o modo escuro antes de publicar', 'Backup das fotos no HD externo',
  'TypeScript: preferir unknown a any', 'Conferir a garantia da geladeira', 'Lavar o carro no fim de semana',
  'Pesquisar preço de cadeira ergonômica', 'Usar índices no Postgres para colunas de busca'
]

/** Regras gerais (valem para tudo): o lugar delas é o tema geral. */
export const GERAIS = [
  { t: 'Responder sempre em português do Brasil', d: 'em que idioma devo responder' },
  { t: 'Não usar emoji nas respostas nem nos commits', d: 'posso usar emoji na resposta' },
  { t: 'Explicar de forma simples, sem jargão técnico', d: 'como devo explicar as coisas' },
  { t: 'Economizar tokens: buscar o trecho em vez de ler o arquivo inteiro', d: 'devo ler o arquivo todo' }
]
