# Publicar no GitHub

## O que ja esta pronto

- repositorio local criado
- `git` pode ser inicializado imediatamente
- scaffold inicial do projeto pronto

## O passo manual que depende de voce

Criar a conta nova no GitHub. Essa parte precisa ser feita por humano por causa de:

- captcha
- email
- possivel verificacao adicional
- aceite de termos

## Conta alvo

- username: `dev865077`
- perfil: [dev865077](https://github.com/dev865077)

## Login correto no GitHub CLI

Hoje o `gh` desta maquina esta autenticado em outra conta.

Para me dar acesso correto a esta conta nova, faca:

```bash
gh auth login --hostname github.com --web
gh auth switch --hostname github.com --user dev865077
gh auth status
```

### Como responder ao `gh auth login`

- Host: `GitHub.com`
- Protocol: `HTTPS`
- Authenticate Git with GitHub credentials: `Yes`
- Login method: `Login with a web browser`

### Importante

Se o navegador tentar entrar automaticamente na conta antiga:

- abra o fluxo em janela anônima
- ou saia da conta antiga no navegador antes
- e complete o login explicitamente com `dev865077`

No final, `gh auth status` deve mostrar:

- conta ativa: `dev865077`

## Sequencia recomendada

1. Fazer o login do `gh` com a conta `dev865077`.
2. Criar um repositório vazio com o nome `depix-mvp`.
3. Voltar aqui para eu conectar o remote, ajustar identidade local, fazer o primeiro commit e publicar.

## Comandos que usaremos depois

```bash
git init -b main
git add .
git commit -m "chore: bootstrap depix mvp repository"
git remote add origin https://github.com/dev865077/depix-mvp.git
git push -u origin main
```
