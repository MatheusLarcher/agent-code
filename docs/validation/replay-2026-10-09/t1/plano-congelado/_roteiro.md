# Retomar fila após travamento
<!-- rev: 6 -->

- [em_andamento] diagnostico: Investigar por que a sessão trava/para sozinha e classificar as causas (código + logs)
<!-- est diagnostico: 25 -->
- [concluida] logs: Log de sessão persistente: ciclo do turno, silêncio, saída do CLI + stderr, retentativas e fila
<!-- est logs: 30 -->
- [concluida] deteccao: Main classifica o fim de cada turno (concluído / falhou / interrompido + motivo), inclusive CLI morto, silêncio além do limite e watchdog do CLI ligado
<!-- est deteccao: 50 -->
- [concluida] retomada: Um único mecanismo de retentativa: 'continue' ou reenvio, esperas 30 s→15 min (6x), erro fatal para, retomada guiada e 'Pular esta tarefa'
<!-- est retomada: 45 -->
- [concluida] fila-preservada: Fila nunca se perde: Stop pausa (Continuar/Limpar), erro retém, reinício do app não descarta nem duplica
<!-- est fila-preservada: 50 -->
- [concluida] avanco-fila: Próximo item só sai com desfecho 'concluido' + fim real confirmado + fila não pausada
<!-- est avanco-fila: 20 -->
- [concluida] validacao: Testes + injeção de falhas em dev para exercitar os 10 cenários no app real (erro, silêncio, CLI morto, Stop, reinício, esgotado, fatal)
<!-- est validacao: 70 -->
