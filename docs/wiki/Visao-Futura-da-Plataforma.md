# Visao Futura da Plataforma

Esta pagina registra a direcao de longo prazo do produto. Ela nao muda o escopo imediato do MVP: o `main` continua orientado ao fluxo DePix no Telegram, com integracao Eulen e operacao multi-tenant em um unico Worker.

## Leitura correta

O DePix MVP e a primeira vertical operacional da plataforma, nao o limite final do sistema.

Hoje o produto prova uma fatia concreta:

- conversa pelo Telegram
- operador/tenant isolado por `tenantId`
- cobranca DePix via Eulen
- persistencia de pedido e deposito
- confirmacao e recheck de pagamento
- documentacao e automacoes de governanca no repositorio

A visao futura e transformar essa fundacao em uma plataforma internacional de ofertas operadas por chat.

## Operador como configurador

No futuro, o operador do sistema deve conseguir escolher o que vende aos clientes finais sem depender de desenvolvimento customizado para cada oferta.

Exemplos de ofertas possiveis:

- cursos
- agendamento de reuniao online
- agendamento de reuniao presencial
- produtos digitais
- conteudo privado por assinatura
- comunidades no estilo membership
- servicos recorrentes
- qualquer produto, servico ou conteudo que possa ser vendido e acompanhado por conversa

O ponto central nao e vender apenas DePix. O ponto central e permitir que o operador modele a propria operacao comercial por chat.

## Interface por chat

A interface principal de configuracao deve ser conversacional sempre que isso reduzir friccao.

O operador deve conseguir definir por chat:

- tipo de oferta
- preco e moeda de referencia
- disponibilidade ou agenda
- regras de entrega
- mensagens para o cliente final
- forma de pagamento aceita
- comportamento depois da confirmacao de pagamento

Isso nao elimina a possibilidade de telas administrativas no futuro, mas evita tratar painel pesado como requisito inicial para toda operacao.

## Internacionalizacao

A plataforma futura deve nascer com a premissa de operacao internacional.

Isso implica documentar e, futuramente, projetar:

- multiplos idiomas
- moedas locais diferentes
- formatos regionais de pagamento
- compliance e regras operacionais por mercado
- experiencias de checkout adaptadas ao pais do cliente
- separacao clara entre tenant, canal, oferta, pagamento e entrega

O MVP atual ainda nao implementa essa camada internacional. A decisao importante agora e nao documentar o produto como se ele fosse limitado para sempre ao Brasil, ao Pix, ao DePix ou ao Telegram.

## Pagamentos e stablecoins

DePix continua sendo a vertical atual. No futuro, outras formas de pagamento devem poder coexistir no mesmo modelo operacional.

Stablecoins podem funcionar como camada de unificacao entre mercados, moedas e regioes porque permitem representar valor de forma programavel, liquidavel e integravel com diferentes rails locais.

Essa visao permite pensar em:

- pagamento local entrando por rail regional
- conversao para uma camada comum de liquidacao
- saldo ou repasse em stablecoin
- conciliacao unificada entre ofertas, tenants e regioes
- menor dependencia de uma unica integracao de pagamento

## Stablecoin propria

A possibilidade de rodar uma stablecoin propria deve permanecer registrada como opcao estrategica de longo prazo.

Essa opcao nao e compromisso de implementacao no MVP. Ela so deve ser considerada quando houver maturidade suficiente em:

- volume operacional
- liquidez
- compliance
- custodia ou emissao
- integracao com rails externos
- governanca financeira
- risco de contraparte

Enquanto isso nao existir, a documentacao deve tratar stablecoin propria como direcao possivel, nao como requisito atual.

## Fora do MVP atual

Esta visao futura nao autoriza misturar escopos no MVP.

Continuam fora do MVP atual:

- marketplace generico
- painel administrativo completo
- checkout multi-moeda
- emissao de stablecoin
- suporte operacional internacional completo
- automacao de entrega para todos os tipos de produto
- integracoes de pagamento alem da vertical DePix/Eulen

Esses itens podem virar backlog futuro, mas devem passar por issues, planning review e PRs proprias.

## Regra de documentacao

Quando uma pagina falar do estado atual, ela deve usar linguagem de MVP.

Quando uma pagina falar da direcao futura, ela deve deixar explicito que se trata de visao de plataforma.

Essa separacao evita duas falhas:

- vender o MVP atual como plataforma completa
- documentar o produto como se a vertical DePix fosse o limite final
