import { configure } from '@testing-library/react'

// waitFor/findBy esperam 1 s por padrão: com a suíte inteira rodando em paralelo,
// a máquina carregada passa disso e testes de tela falham por tempo (itens 3.13
// e 3.23). 10 s só pesa quando a condição demora; o caso normal sai na hora.
configure({ asyncUtilTimeout: 10_000 })
