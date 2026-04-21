# Testes e Qualidade

## Como a suite e organizada

- testes de unidade
- testes de integracao de Worker
- testes de contrato de rotas
- testes de regressao operacional

## Comandos principais

- `npm test`
- `npm run typecheck`
- `npm run cf:types`

## Regra de manutencao

Mudancas que alterem comportamento, contrato de rota, bootstrap ou operacao precisam vir acompanhadas de teste ou de validacao equivalente.

## Migracao TypeScript

A matriz operacional da migracao TypeScript fica em [Validacao e Rollback TypeScript](Validacao-e-Rollback-TypeScript).

Para ondas sensiveis, `npm test` sozinho nao e evidencia suficiente. A PR deve listar tambem os comandos focados, smokes HTTP ou dry-runs exigidos para a superficie alterada.
