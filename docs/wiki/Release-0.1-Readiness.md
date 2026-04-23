# Release 0.1 Readiness

## Objetivo

Esta pagina consolida a leitura operacional da prova 0.1 e os criterios para considerar a release pronta para uso real em `Alpha Production`.

## Escopo

A release 0.1 cobre o fluxo operacional minimo do MVP com foco em:

- leitura de readiness
- runbook canonico
- validacao operacional antes de compra real
- evidencia de operacao e acompanhamento

Alguns itens podem ficar para `0.2` se houver runbook e aviso operacional:

- refinamentos de copy
- automatizacoes adicionais de suporte
- ajustes incrementais de observabilidade

O runbook canonico da prova operacional 0.1 esta em [Deploy e Runbooks](Deploy-e-Runbooks#runbook-da-prova-operacional-01).

Antes de qualquer compra real, execute o preflight canonico:

```bash
npm run release:0.1:check
```

Esse comando nao faz compra real nem pagamento. Ele valida `production/alpha`, grava um JSON em `artifacts/release-0.1/` e falha antes da prova viva quando faltar token operacional, webhook Telegram, configuracao do tenant ou confirmacao externa do webhook Eulen.

Estado atual do runbook: `validacao limitada`. Ele ja define pre-requisitos, passo a passo, checkpoints, fontes de log, validacao de reconciliacao Eulen e decisoes `pronto`, `recheck`, `fallback` e `falha`. A validacao passa para `completa` somente depois de uma compra real em `Alpha Production` anexar a evidencia obrigatoria.

## Leitura correta

Esta pagina nao substitui o runbook. Ela aponta o estado de prontidao e as regras de entrada para a prova 0.1.

## Criterios de prontidao

Para considerar a release pronta, o time deve ter:

- runbook disponivel e coerente
- ambiente `Alpha Production` acessivel
- secrets operacionais configurados
- validacao de integracao concluida
- evidencia de execucao disponivel
- preflight canonico aprovado

## Evidencia esperada

A evidencia da release deve incluir, quando aplicavel:

- resultado do preflight canonico
- logs operacionais relevantes
- confirmacao de webhook e tenant
- trilha de validacao Eulen
- registro da compra real quando ocorrer

## Nota operacional

Nada nesta pagina autoriza compra real sem a execucao previa do preflight canonico e sem o runbook correspondente.
