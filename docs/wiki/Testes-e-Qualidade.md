# Testes e Qualidade

## Stack definida

- `Vitest`
- testes de `Cloudflare Workers`
- `MSW`

## Suite atual no repositorio

- `test/health.test.js`
- `test/tenant-routing.test.js`
- `test/telegram-runtime.test.js`
- `test/telegram-webhook-reply.test.js`
- `test/eulen-client.test.js`
- `test/db.repositories.test.js`

## Estado atual do CI

O workflow `CI` do GitHub Actions esta em estabilizacao operacional e nao deve ser lido como pipeline final madura e obrigatoria em todos os fluxos.

## Leitura correta

A estrategia de qualidade existe e a suite existe, mas a automacao do CI ainda precisa ser tratada como backlog proprio para virar gate confiavel.
