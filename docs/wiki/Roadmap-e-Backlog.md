# Roadmap e Backlog

## Leitura executiva

O backlog do projeto ja separa bem o que e fundacao, persistencia, integracao e qualidade. A prioridade continua sendo fechar o caminho critico do MVP sem abrir frentes paralelas desnecessarias.

## Eixos de entrega

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

## Estado atual

- fundacao do Worker e multi-tenancy: avancadas
- persistencia base: avancada
- fluxo funcional completo do bot: pendente
- webhook principal real: avancado
- recheck real: pendente
- CI automatizado estavel: em backlog proprio

## Fonte de verdade

Para granularidade de backlog, aceite e dependencia, consulte o backlog versionado do repositorio e as issues do GitHub.
