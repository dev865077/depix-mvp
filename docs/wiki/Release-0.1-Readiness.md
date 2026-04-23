# Release 0.1 Readiness

## Objetivo

Esta pagina registra o que ainda precisa estar pronto para a release `0.1` ser considerada segura para corte.

## Critérios de corte

- o fluxo principal precisa estar validado no ambiente alvo
- os webhooks operacionais precisam estar documentados e funcionais
- os segredos e bindings de ambiente precisam estar definidos
- os runbooks de operacao precisam existir e refletir o comportamento atual
- qualquer dependência externa critica precisa ter procedimento de validacao e rollback

## Itens que podem bloquear o corte

- divergencia entre documento e codigo
- ausencia de runbook operacional para um fluxo novo
- falta de evidencia de teste humano ou prova operacional
- dependencia externa sem instrucao de validacao ou recuperacao
- mudancas em ambiente, segredo, fluxo de pagamento ou webhook sem atualizacao documental na mesma PR

## Itens que podem ficar para 0.2

Alguns itens podem ficar para `0.2` se houver runbook e aviso operacional:

- melhorias de ergonomia nao criticas
- refinamentos de copy que nao alterem o fluxo
- expandir observabilidade alem do minimo necessario para operar
- automatizacoes que nao sejam criticas para a liberacao da release

## Runbook operacional

O runbook canonico da prova operacional 0.1 esta em [Deploy e Runbooks](Deploy-e-Runbooks#runbook-da-prova-operacional-01).

Antes de qualquer compra real, execute o preflight canonico:

```bash
npm run release:0.1:check
```

Esse comando nao faz compra real nem pagamento. Ele valida `production/alpha`, grava um JSON em `artifacts/release-0.1/` e falha antes da prova viva quando faltar token operacional, webhook Telegram, configuracao do tenant ou confirmacao externa do webhook Eulen.

Estado atual do runbook: `validacao limitada`. Ele ja define pre-requisitos, passo a passo, checkpoints, fontes de log, validacao de reconciliacao Eulen e decisoes `pronto`, `recheck`, `fallback` e `falha`. A validacao passa para `completa` somente depois de uma compra real em `Alpha Production` anexar a evidencia obrigatoria.

## Leitura correta

Esta pagina nao substitui o runbook nem a documentacao de integracao. Ela so define o que ainda bloqueia o corte de release.

## Regra de manutencao

- toda mudanca que altere ambiente, segredo, fluxo de pagamento ou webhook precisa atualizar esta pagina na mesma PR
- se o runbook mudar, esta pagina precisa apontar para a versao canonica atual
- se a validacao operacional avancar, o estado da validacao precisa ser reescrito aqui
