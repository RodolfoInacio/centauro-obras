# Configuração do Supabase — passo a passo

Guia para montar o ambiente do zero (projeto novo, ou recriar o atual).
Os passos 1 a 7 são obrigatórios; 8 e 9 ligam a importação de PDF por IA e o deploy automático.

## 1. Criar o projeto
1. Entre em https://supabase.com → **New project** (plano Free).
2. Escolha um nome (ex: `centauro-obras`) e uma senha de banco (guarde).
3. Região: escolha a mais próxima (ex: South America / São Paulo).

## 2. Rodar o schema
1. No painel do projeto → **SQL Editor** → **New query**.
2. Cole TODO o conteúdo de `supabase/schema.sql` e clique **Run**.
3. Deve criar as tabelas `obras`, `equipes`, `profiles`, `obra_membros`, o bucket `desenhos`
   e a função `public.is_admin()` (usada por todas as políticas de acesso).

## 3. Rodar as duas migrations restantes ⚠️
O `schema.sql` **não cria tudo**. Rode também, na mesma tela do SQL Editor, um de cada vez:

1. `supabase/migration_ordens.sql` → cria a tabela **`ordens`** (Ordens de Serviço).
2. `supabase/migration_cronogramas.sql` → cria a tabela **`cronogramas`** (Cronograma Comercial).

**A ordem importa**: as duas usam `public.is_admin()`, que só existe depois do passo 2.

> **Por que isso é fácil de esquecer**: se você pular este passo, o app **não quebra** — ele abre
> normalmente, mas Ordem de Serviço e Cronograma aparecem sempre vazios e nada que você criar
> nessas telas é salvo. O código engole o erro de propósito (`fetchOrdens` / `fetchCronogramas`
> em `src/api.js`) para não derrubar o sistema inteiro. Se essas duas telas estiverem "esquecendo"
> o que você cria, é aqui que está o problema.

## 4. Desligar cadastro público
- **Authentication → Sign In / Providers → Email**: desligue **"Allow new users to sign up"**.
  (Assim ninguém de fora cria conta; só você cria os usuários.)

## 5. Criar os logins do escritório
- **Authentication → Users → Add user → Create new user**.
- Informe email + senha de cada pessoa (marque "Auto Confirm User").
- Todo usuário criado vira `admin` automaticamente (trigger `handle_new_user` no schema).

## 6. Pegar as chaves
- **Project Settings → API**:
  - **Project URL** → vira `VITE_SUPABASE_URL`
  - **anon public key** → vira `VITE_SUPABASE_ANON_KEY`
  - **service_role key** (secreta!) → usada SÓ na migração local do passo 10

## 7. Criar o `.env` local
Copie `.env.example` para `.env` na raiz do projeto e preencha com os valores do passo 6:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

O `.env` está no `.gitignore` — nunca vai para o GitHub. Depois disso, `npm run dev` já abre o
sistema funcionando em http://localhost:5173.

## 8. Importação de PDF por IA (Edge Function)
A leitura automática do orçamento em PDF usa uma Edge Function que chama a API da Anthropic.
Sem estes dois passos, a importação continua funcionando, mas cai no leitor local (menos preciso)
e avisa na tela.

1. **Chave da Anthropic**: crie em https://console.anthropic.com → Settings → API Keys.
2. **Guardar a chave no Supabase**: painel do projeto → **Edge Functions → Secrets** →
   *Add new secret* → nome `ANTHROPIC_API_KEY`, valor = a chave.
   (Guarde por aqui, não pelo terminal — a CLI costuma dar `Unauthorized` nesse comando.)
3. **Publicar a função**:
   ```bash
   npx supabase functions deploy parse-obra-pdf --project-ref <SEU-PROJECT-REF>
   ```
   O `project-ref` é o código do projeto (está em `supabase/config.toml` e na URL do Supabase).
   Este comando precisa de um **Personal Access Token**: painel → avatar → **Access Tokens** →
   *Generate new token*. Antes de rodar o deploy:
   ```bash
   # PowerShell
   $env:SUPABASE_ACCESS_TOKEN="seu-token"
   ```
   O token do `npx supabase login` comum **não serve** para isso (devolve 401).

## 9. Secrets do GitHub (deploy automático)
Em `github.com/<usuário>/<repo>` → **Settings → Secrets and variables → Actions**, crie:

| Secret | Para quê |
|---|---|
| `VITE_SUPABASE_URL` | o site publicado saber a qual Supabase se conectar |
| `VITE_SUPABASE_ANON_KEY` | idem |
| `SUPABASE_ACCESS_TOKEN` | publicar as Edge Functions junto com o site |

Sem `SUPABASE_ACCESS_TOKEN` o site continua publicando normalmente, mas o passo das Edge
Functions é pulado — toda alteração na função precisa do deploy manual do passo 8.

## 10. Migração inicial dos dados (só na primeira vez)
Se houver dados antigos para importar (desenhos em base64 + obras):

1. Crie na raiz o arquivo `seed.secrets.json` (já está no `.gitignore`):
   ```json
   { "url": "https://SEU-PROJETO.supabase.co", "serviceRole": "SUA_SERVICE_ROLE_KEY" }
   ```
2. Rode:
   ```bash
   node seed_supabase.mjs
   ```

A `service_role` ignora o RLS — por isso só roda localmente e nunca vai para o site.

---

## Conferindo se ficou tudo certo

- [ ] Login funciona com um dos usuários criados no passo 5.
- [ ] A lista de obras carrega.
- [ ] **Cronograma Comercial**: criar um cronograma, sair da tela e voltar — tem que continuar lá.
      Se sumir, faltou o passo 3.
- [ ] **Ordem de Serviço**: gerar uma O.S. e recarregar a página — tem que continuar lá.
      Se sumir, faltou o passo 3.
- [ ] **Importar PDF**: não deve aparecer o aviso "extração local (IA indisponível)".
      Se aparecer, revise o passo 8.
