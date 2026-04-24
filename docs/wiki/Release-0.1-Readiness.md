# Release 0.1 Readiness

## Objetivo

Esta pagina consolida a leitura operacional da release `0.1` para uso real em `Alpha Production`.

## Estado atual

Estado da `0.1`: `pronta operacionalmente para o fluxo Alpha Production validado`.

Evidencia primaria:

- `#688` esta fechada com prova real Alpha Production aprovada apos as mudancas de payment-boundary.
- Artefato registrado em `artifacts/release-0.1/live-alpha-production-20260423T220428Z.json`.
- Resultado registrado em `#688`: `orderStatus=paid`, `orderCurrentStep=completed`, `depositStatus=depix_sent`, `splitProof=proved`, webhook processado e notificacao final enviada no Telegram.
- Deploy usado na prova de `#688`: version ID `f2da7e6f-743b-4559-8ca8-038df8db2763`, commit `d1789efa41a036fc7f88d0410f42924edba902cb`.

Evidencia historica:

- `#634` tambem registrou prova real Alpha Production aprovada em `artifacts/release-0.1/live-alpha-production-20260423T101726Z.json`.
- `#634` permanece como evidencia historica anterior as mudancas recentes do caminho de pagamento.

## Pendencias conhecidas

`#585` segue aberta e e a fonte da remocao planejada das camadas automaticas de recuperacao:

- cron de reconciliacao agendada
- fallback operacional por listagem `/deposits`
- artefatos ligados a `scheduled_deposit_reconciliation_claims`

Enquanto `#585` estiver aberta, a documentacao deve tratar essas camadas como existentes e pendentes de remocao, nao como removidas. O caminho operacional preferido para pagamento nao confirmado pelo webhook e o recheck manual por `depositEntryId`.

## Escopo da 0.1

A release 0.1 cobre o fluxo operacional minimo do MVP:

- bot Telegram Alpha Production
- criacao de pedido Pix -> DePix
- confirmacao por webhook Eulen
- notificacao final de pagamento no Telegram sem reenviar QR/Pix
- split configurado e comprovado no artefato de evidencia
- runbook operacional para preflight, prova viva e recheck manual

## Preflight

Antes de nova compra real controlada, execute o preflight canonico:

```bash
npm run release:0.1:check
```

O preflight nao faz compra real nem pagamento. Ele valida `production/alpha`, grava um JSON em `artifacts/release-0.1/` e falha antes da prova viva quando faltar token operacional, webhook Telegram, configuracao do tenant ou confirmacao externa do webhook Eulen.

Nota: durante a preparacao registrada em `#688`, o preflight local nao conseguiu consultar rotas autenticadas porque `OPS_ROUTE_BEARER_TOKEN` nao estava disponivel no shell local. A prova viva de `#688` foi concluida com sucesso e a evidencia final foi registrada na issue.

## Criterios de prontidao

Para considerar a release pronta no escopo acima, o time deve ter:

- runbook disponivel e coerente
- ambiente `Alpha Production` acessivel
- secrets operacionais configurados no Worker
- migrations remotas limpas
- preflight executado ou limitacao operacional explicitamente registrada
- prova real registrada com `finalStatus=passed`
- webhook Eulen observado
- pedido finalizado como `paid/completed`
- `depositStatus=depix_sent`
- `splitProof=proved`
- mensagem final do Telegram enviada sem repetir QR/Pix

## Artefatos

- Prova atual pos payment-boundary: `artifacts/release-0.1/live-alpha-production-20260423T220428Z.json`.
- Nota curta de demo: `artifacts/release-0.1/demo-readiness-20260423T2152Z.md`.
- Prova historica anterior: `artifacts/release-0.1/live-alpha-production-20260423T101726Z.json`.

## Runbook

O runbook canonico da prova operacional 0.1 esta em [Deploy e Runbooks](Deploy-e-Runbooks#runbook-da-prova-operacional-01).
