## tenant-routing.test.js

Este teste cobre o roteamento multi-tenant da borda HTTP do Worker.

O que ele verifica:

- `POST /telegram/alpha/webhook` entra na rota do Telegram para um tenant valido
- `POST /webhooks/eulen/beta/deposit` resolve o tenant correto na rota de webhook da Eulen
- uma rota com tenant inexistente falha com `404`

Observacao:

- este arquivo documenta apenas o que o teste faz hoje
- ele nao define regra de produto nova nem substitui a documentacao de arquitetura
