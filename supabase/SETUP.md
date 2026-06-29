# Configuração do Supabase — passo a passo

## 1. Criar o projeto
1. Entre em https://supabase.com → **New project** (plano Free).
2. Escolha um nome (ex: `centauro-obras`) e uma senha de banco (guarde).
3. Região: escolha a mais próxima (ex: South America / São Paulo).

## 2. Rodar o schema
1. No painel do projeto → **SQL Editor** → **New query**.
2. Cole TODO o conteúdo de `supabase/schema.sql` e clique **Run**.
3. Deve criar as tabelas `obras`, `equipes`, `profiles`, `obra_membros` e o bucket `desenhos`.

## 3. Desligar cadastro público
- **Authentication → Sign In / Providers → Email**: desligue **"Allow new users to sign up"**.
  (Assim ninguém de fora cria conta; só você cria os usuários.)

## 4. Criar os logins do escritório
- **Authentication → Users → Add user → Create new user**.
- Informe email + senha de cada pessoa (marque "Auto Confirm User").

## 5. Pegar as chaves
- **Project Settings → API**:
  - **Project URL**  → vira `VITE_SUPABASE_URL`
  - **anon public key** → vira `VITE_SUPABASE_ANON_KEY`
  - **service_role key** (secreta!) → usada SÓ na migração local

## 6. Me enviar (para conectar e migrar)
- Project URL + anon key (podem ir no chat).
- service_role key: prefira me passar com cuidado — ela fica só num arquivo local
  `seed.secrets.json` (que já está no .gitignore e nunca vai pro GitHub).

---

### Depois disso eu faço:
- Crio o `.env` local, rodo `node seed_supabase.mjs` (sobe desenhos + obras).
- Troco o app para login + banco e testo.
- Subo no GitHub, configuro os Secrets e publico no GitHub Pages.
