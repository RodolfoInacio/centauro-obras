# CLAUDE.md — Gestão de Obras · Centauro Esquadrias

## O que é

App web interno para acompanhar obras de esquadrias de alumínio e vidro: importa o orçamento em
PDF, controla itens/etapas/equipes, distribui obra × equipe no calendário e imprime a O.S. dali,
monta cronograma estilo MS Project e
acompanha o financeiro por obra (recebido, a receber, compras por categoria).
Uso interno do escritório — sem cadastro público, login criado manualmente no Supabase.
Produção: <https://obras.centauroesquadrias.com.br>

## Stack (versões instaladas, conferidas em node_modules)

| Peça | Versão |
|---|---|
| React / React DOM | 19.2.7 |
| Vite | 8.0.16 (`@vitejs/plugin-react` 6.0.2) |
| Supabase JS | 2.108.2 (Postgres + Auth + Storage) |
| Edge Function | Deno, na infra do Supabase |
| Hospedagem | GitHub Pages (domínio próprio via `public/CNAME`) |

Sem framework de teste, sem linter, sem router, sem lib de gráfico, sem lib de UI. Estilo é
`style={{}}` inline em tudo.

## Estrutura

```
src/
  App.jsx          ~2.700 linhas — TODOS os componentes e telas. É o app inteiro.
  api.js           CRUD do Supabase (obras, equipes, agenda, cronogramas).
  supabase.js      Cria o client a partir das env vars.
  cronograma.js    Motor de agendamento do Cronograma Comercial (dias úteis, dependências).
  Modal.jsx        Único componente extraído: modal genérico com backdrop.
  index.css        CSS global mínimo.
  assets/          Logos.
supabase/
  schema.sql                 Tabelas base + RLS + bucket de Storage.
  migration_ordens.sql       Tabela `ordens` — histórica, sem tela (ver Decisões).
  migration_cronogramas.sql  Tabela `cronogramas` (rodar separado).
  functions/parse-obra-pdf/  Edge Function que chama a IA para ler o PDF.
  SETUP.md                   Passo a passo de criação do projeto Supabase.
docs/
  integracao-erp.md      Spec completa da integração com o ERP (uso interno).
  integracao-erp-ti.md   Versão enxuta, para enviar ao dev do ERP.
public/CNAME       Domínio do GitHub Pages.
seed_supabase.mjs  Migração única inicial (roda local, usa service_role).
```

**Órfãos do template Vite — não são importados por ninguém**: `src/counter.ts`, `src/main.ts`,
`src/style.css`. `main.ts` importa os outros dois, mas `index.html` carrega só `src/main.jsx`.
Podem ser apagados.

## Rodar

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # gera dist/
npm run preview  # serve o dist/
```

Precisa de um `.env` na raiz (copie de `.env.example`). **Não há testes** — nenhum framework
instalado, nenhum arquivo de teste. Verificação é `npm run build` + conferir no navegador.

## Deploy

Automático: **push na `main`** dispara `.github/workflows/deploy.yml`.
- job `build` → `npm ci` + `npm run build` (injeta as env vars dos secrets) → publica `dist/` no Pages.
- job `functions` → publica as Edge Functions. **Pulado silenciosamente** se o secret
  `SUPABASE_ACCESS_TOKEN` não existir (é o caso hoje — ver Pendências).

Deploy manual da Edge Function, quando necessário:

```bash
npx supabase functions deploy parse-obra-pdf --project-ref rlyfnlsntlasrwvmgjbo
```

Precisa de um Personal Access Token do Supabase em `SUPABASE_ACCESS_TOKEN` — o token do
`supabase login` normal **não tem permissão** e devolve 401.

## Banco (Supabase / Postgres)

As tabelas de dados seguem o mesmo padrão: **colunas soltas só para busca/ordenação, e o objeto
inteiro do app numa coluna `data jsonb`**. A fonte de verdade é o `jsonb`.

| Tabela | PK | Colunas | `data` contém |
|---|---|---|---|
| `obras` | `id` (= nº da proposta, texto) | `numero`, `cliente`, `updated_at`, `data` | a obra inteira (itens, etapas, financeiro, compras) |
| `equipes` | `id` | `nome`, `integrantes` (jsonb), `cor` | — (essa não usa `data`) |
| `ordens` | `id` | `numero`, `equipe_id`, `periodo_inicio`, `periodo_fim`, `data` | **histórica** — nenhum código lê ou grava (ver Decisões) |
| `agenda` | `id` | `dia`, `equipe_id`, `obra_id`, `updated_at`, `data` | o serviço do dia (obra × equipe × período) |
| `cronogramas` | `id` | `titulo`, `obra_id`, `updated_at`, `data` | o cronograma inteiro (tasks) |
| `profiles` | `id` (= auth.users) | `nome`, `papel` | — |
| `obra_membros` | (`obra_id`,`user_id`) | `papel` | — (**vazia**, fundação para o futuro) |

- `obra_membros` e os papéis `encarregado`/`cliente` existem no schema mas **não são usados**: as
  policies que dariam acesso a eles estão comentadas em `schema.sql`. Hoje só `admin` acessa.
- Todo usuário novo vira `admin` automaticamente (trigger `handle_new_user`).
- Storage: bucket público `desenhos` (leitura pública, escrita autenticada).
- `agenda` e `cronogramas` **não estão no `schema.sql`** — são migrations separadas. Se esquecer
  de rodar, o app não quebra: `fetchAgenda`/`fetchCronogramas` capturam o erro e devolvem `[]`.

## Backend

Não há backend próprio. O front fala direto com o Supabase (PostgREST + Auth), protegido por RLS.
A única peça server-side é uma Edge Function:

| Função | Entrada | O que faz |
|---|---|---|
| `parse-obra-pdf` | `POST { lines: string[], filename }` + `Authorization: Bearer <jwt>` | Valida o usuário, manda o texto do PDF para a API da Anthropic (`claude-sonnet-5`, tool-use forçado) e devolve a obra estruturada. Erros → 400/401/500/502; o cliente cai no parser local. |

Planejado e **ainda não implementado**: `erp-webhook`, para receber financeiro do ERP
(contrato em `docs/integracao-erp-ti.md`).

## Variáveis de ambiente (só os nomes)

| Nome | Onde vive | Para quê |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env` local + secret do GitHub | URL do projeto Supabase |
| `VITE_SUPABASE_ANON_KEY` | `.env` local + secret do GitHub | chave pública do Supabase (vai para o bundle, é pública por design) |
| `ANTHROPIC_API_KEY` | secret do **Supabase** (Edge Functions → Secrets) | chave da API da Anthropic usada pela Edge Function |
| `SUPABASE_ACCESS_TOKEN` | secret do GitHub | permite o CI publicar Edge Functions |
| `SUPABASE_SERVICE_ROLE` | `seed.secrets.json` local | só para o `seed_supabase.mjs`; ignora RLS, nunca sai da máquina |

`.env` e `seed.secrets.json` estão no `.gitignore`. **Nunca commitar valores.**

## Convenções

- **Idioma**: código, comentários e commits em português. Nomes de campo em português
  (`valorRecebido`, `statusCompras`).
- **Componentes**: tudo em `App.jsx`, na ordem em que aparece na navegação. Não criar arquivo
  novo por componente a menos que o componente seja genérico e reutilizado (só `Modal.jsx` é).
- **Navegação**: sem router. Estado `view = {type, ...params}` no `App` + pilha `history`.
  `navTo` empilha, `navReplace` troca, `back` desempilha, `goHome` limpa. Todos passam por
  `guardNav`, que intercepta a saída se houver cronograma com gravação pendente.
  Tipos de view: `dashboard`, `obrasPasta` (`pasta: "andamento"|"concluidas"`), `gantt` (`obraId`),
  `print` (`obraId`), `calendar`, `equipes`, `osPrint` (`inicio`, `fim`),
  `cronogramas`, `cronograma` (`id`), `financeiro`.
- **Persistência**: o estado local muda na hora; a gravação é **debounced em 700 ms por entidade**
  (`persistObra`, `handleSaveCronograma`, `handleSaveAgendamento`). Equipes gravam imediatamente,
  uma por vez (`upsertEquipe`/`deleteEquipe`). O cronograma é o único com indicador de "não salvo"
  (`dirtyCronoIds`), botão Salvar e aviso ao sair.
- **Migração de schema**: nunca migrar o banco — os campos novos entram com default em `normObra`
  / `normItem`, sempre undefined-safe. Registro antigo continua abrindo.
- **Erros**: `api.js` faz `throw` no que é essencial (obras, equipes) e `console.warn` + `[]` no
  que é opcional (agenda, cronogramas). Na UI, erro vira faixa vermelha temporária via `showError`.
- **Autenticação**: `supabase.auth.signInWithPassword`. Sem cadastro público — usuários são
  criados à mão no painel do Supabase.

## Decisões arquiteturais (e o que foi descartado)

**`jsonb` em vez de tabelas normalizadas.** A obra é um documento aninhado (itens → etapas →
datas). Normalizar exigiria migration a cada campo novo; com `jsonb` + `normObra`, campo novo é
uma linha de default. Custo aceito: não dá para fazer query SQL por campo interno.

**Importação de PDF: IA com fallback para regex.** Os orçamentos vêm todos do mesmo sistema, mas
variam muito (obra de serviço avulso sem medidas, código de tipo às vezes ausente, quebras de
linha diferentes). O regex puro exigia remendo a cada formato novo. Hoje o caminho principal é a
Edge Function com IA; se ela falhar **ou devolver zero itens**, cai automaticamente no parser
regex antigo e avisa na tela. Descartado: só regex (frágil) e chamar a Anthropic do browser
(exporia a chave).

**Pastas por status em vez de lista única.** O "progresso médio" sobre todas as obras era falso —
metade já estava concluída. A tela inicial mostra só os KPIs gerais + duas pastas; o progresso
real aparece dentro de "Em Andamento". Pasta é só um filtro por `status`, sem campo novo: mudar o
status move a obra sozinha.

**"A comprar" = o previsto, sem subtrair o realizado.** Previsto e realizado são grandezas
independentes no processo da Centauro (previsto é estimativa daquele material; realizado é o que
saiu). Subtrair zerava o pendente sempre que a obra já tinha gasto mais que o previsto restante.
Por isso `comprasTotais().aComprar === previsto`, ignorando categorias marcadas `naoSeAplica`.
A flag 🚩 acende quando `aComprar > (valorTotal − valorRecebido)`.

**Status de Compras/Fabricação/Instalação são campos manuais**, não derivados das etapas dos
itens: a planilha que o escritório mantém já traz esses status prontos e é mais fiel que os
checkboxes por item.

**Gráficos em SVG puro** (`PieChart`), sem lib. Uma dependência de gráfico pesaria mais que o
donut de duas fatias que precisamos.

**Sem router.** ~12 telas num app interno não pagam a dependência; o estado `view` + pilha resolve,
inclusive o "voltar" universal.

**A O.S. sai da agenda, não das datas da obra.** Havia duas fontes de verdade para "quem faz o
quê em que dia": o `OrdemBuilder` deduzia as linhas das datas dos itens (`obraAtivaNoDia`),
enquanto o calendário é preenchido à mão arrastando obra × equipe. A O.S. imprimia a dedução, que
não era o que a equipe ia fazer. Hoje a tela de Ordem de Serviço não existe mais: o calendário
emite direto (botão no mês, com escolha de período, e no dia aberto), gerando uma folha por equipe
via `OrdemServicoPrint`. A O.S. **não é salva nem numerada** — o registro é a própria agenda, então
não há como a folha e o calendário divergirem. A tabela `ordens` continua no banco com as O.S.
antigas, mas nenhum código a lê; para consultar, é ir no Supabase.

**Equipe é gravada uma por vez.** `saveEquipes` regravava a lista inteira e engolia o erro do
SELECT, então o DELETE muitas vezes nem era enviado e a função resolvia como sucesso — a equipe
sumia da tela e voltava no F5. Agora são `upsertEquipe`/`deleteEquipe`; o delete pede as linhas de
volta (`.select("id")`) e **falha se o banco não apagou nada**, porque um DELETE barrado por RLS
volta 204 sem erro. Se a gravação falhar, a equipe é restaurada na lista em vez de sumir.

## Armadilhas conhecidas

- **`normObra` quebra se a obra não tiver `itens`**: faz `o.itens.map(...)` sem guarda, e isso
  roda na carga de todas as obras — um registro ruim derruba a tela inteira.
- **A senha do Financeiro (`SENHA_FINANCEIRO`) é uma constante no código do cliente.** Está no
  bundle publicado; qualquer um lê no devtools. É uma tranca visual, não segurança.
- **`pdf.js` vem de CDN em runtime**, injetado por `useEffect` no `App`. Sem internet (ou com o
  CDN fora), a importação de PDF falha com "pdf.js não carregado". Não usar `<script>` no JSX
  para carregá-lo: o React não executa esse script — foi exatamente esse o bug que quebrou o
  import por semanas.
- **`extractPdfLines` começa na página 2** — a página 1 do orçamento é capa e é ignorada de
  propósito. PDF com layout diferente perde a primeira página de itens.
- **Arrastar para reordenar é sensível a duas coisas**: o card precisa nascer `draggable`
  (a trava de "só arrasta pela alça" vive num `useRef`, não em estado, porque o navegador decide
  no `mousedown`, antes de qualquer re-render); e o cálculo do destino usa a lista **já ordenada**
  (`displayed`), não o array cru — usar o cru dessincroniza depois do primeiro arrasto.
- **`obra.material`** (dataLimite/dataCompra/previsaoEntrega) ainda é criado em três lugares mas
  **não tem mais UI** — as datas viraram por categoria em `obra.compras`. Campo vestigial.
- **`parsePDFFile` está morto**: ninguém chama. O fallback usa `parseObraLines` direto.
- **TypeScript é decorativo**: `tsconfig.json` existe e `typescript` está nas devDependencies,
  mas o app é todo `.jsx` e não há `tsc` em nenhum script. Idem `vite-plugin-singlefile`, que
  está nas deps mas não é usado no `vite.config.js`.
- **Deploy do Pages às vezes trava na fila** do GitHub (job `deploy` fica em `queued`
  indefinidamente com build já verde). Cancelar o run e disparar de novo resolve.
