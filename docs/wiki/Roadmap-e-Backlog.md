# Roadmap e Backlog

## Leitura executiva

O backlog do projeto ja separa bem o que e fundacao, persistencia, integracao e qualidade. A prioridade continua sendo fechar o caminho critico do MVP sem abrir frentes paralelas desnecessarias.

## Eixos de entrega

### Visao de plataforma

- documentar o MVP atual como primeira vertical DePix/Telegram
- preservar a direcao futura multi-oferta sem misturar isso no escopo imediato
- tratar internacionalizacao, multiplos pagamentos e stablecoins como evolucao planejada
- avaliar stablecoin propria apenas como opcao estrategica de longo prazo

### Fundacao

- Worker base com `Hono`
- configuracao por ambiente
- secrets fora do codigo

### Persistencia

- `D1` como banco unico do MVP
- migrations versionadas
- repositorios com SQL cru parametrizado

### Integracao e fluxo

- runtime Telegram real
- cobranca real via Eulen
- webhook principal de confirmacao
- recheck por fallback

### Qualidade

- suite automatizada forte
- CI confiavel
- regras de observabilidade e tratamento de erro

## Regra de prioridade

- `P0` antes de `P1`
- nao puxar item com dependencia aberta
- nao misturar feature funcional com refatoracao estrutural aleatoria
- nao transformar visao futura em requisito de MVP sem issue, planning review e PR propria
- nao inflar backlog com `epic:` falsa; `epic` so existe quando ha varias sub-issues executaveis e encadeadas

## Estado atual

- fundacao do Worker e multi-tenancy: avancadas
- persistencia base: avancada
- marco inicial de QR real no Telegram ja foi atingido, mas isso nao significa ciclo completo concluido
- etapas posteriores ao QR, validacao operacional final e fechamento completo do ciclo ainda seguem no backlog
- webhook principal real: avancado
- recheck real: avancado, com `deposit-status` por deposito e `deposits` por janela
- backlog novo passa por gate de planning review em Discussions antes da implementacao de itens de maior impacto
- itens novos que ainda falharem no planning entram na lane automatica de refinement da issue antes de qualquer trabalho de codigo
- itens antigos nao entram nesse gate automaticamente: o mantenedor deve reenfileirar por comentario na Discussion ou por rerun manual do workflow
- a visao futura de plataforma esta documentada em [Visao Futura da Plataforma](Visao-Futura-da-Plataforma), separada do escopo operacional imediato

## Fonte de verdade

Para granularidade de backlog, aceite e dependencia, consulte o backlog versionado do repositorio e as issues do GitHub.
