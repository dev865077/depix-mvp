# Visao Geral do Produto

## Resumo

O `depix-mvp` e um bot Telegram multi-tenant para parceiros operarem o fluxo `DePix` sem precisar de um runtime separado por parceiro.

Este objetivo descreve o MVP atual. A direcao de longo prazo esta separada em [Visao Futura da Plataforma](Visao-Futura-da-Plataforma), para nao confundir a vertical DePix/Telegram com o produto final desejado.

## O que o sistema faz

- recebe o usuario no bot do parceiro
- conduz o fluxo de pedido
- cria a cobranca na Eulen
- persiste `orders`, `deposits` e `deposit_events`
- confirma pagamento via webhook
- permite recheck e fallback operacional

## O que o sistema nao e

- nao e um checkout genérico pronto para qualquer catalogo
- nao e um SaaS completo de painel administrativo
- nao e um sistema de entrega externa completo para `BTC` e `USDT`
- nao e uma arquitetura distribuida

## Relacao com a visao futura

O MVP atual prova uma vertical concreta: conversa no Telegram, criacao de cobranca DePix, persistencia e conciliacao operacional.

A plataforma futura deve poder ir alem dessa vertical. O operador podera escolher o que vende por chat, como cursos, agendamentos, produtos digitais, conteudo privado, assinaturas, comunidades ou servicos. Essa expansao deve ser tratada como evolucao planejada, nao como requisito escondido do MVP.

Pagamentos tambem podem evoluir alem de DePix. A visao futura admite multiplos rails, operacao internacional e stablecoins como camada comum de liquidacao. A possibilidade de uma stablecoin propria fica registrada como opcao estrategica de longo prazo, sem compromisso de implementacao nesta fase.

## Leitura correta do estado atual

O desenho do produto esta mais maduro do que a implementacao final do fluxo. O `main` ja sustenta a base tecnica e os contratos principais, mas ainda nao materializa toda a jornada funcional do bot.
