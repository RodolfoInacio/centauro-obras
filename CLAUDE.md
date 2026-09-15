# CLAUDE.md — Gestão de Obras · Centauro Esquadrias

## O que é

App web interno para acompanhar obras de esquadrias de alumínio e vidro: importa o orçamento em
PDF, controla itens/etapas/equipes, distribui obra × equipe no calendário e imprime a O.S. dali,
mantém um mural de lembretes ao lado do calendário, registra o diário de obra de cada dia (com
foto marcada à mão), monta cronograma estilo MS Project,
acompanha o financeiro por obra (recebido, a receber, compras por categoria) e controla o
estoque (entrada/saída com documento numerado, etiqueta com QR e código de barras).
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
`style={{}}` inline em tudo. As únicas libs além de React/Supabase são `qrcode` e `jsbarcode`, só
para as etiquetas do estoque, carregadas com `import()` na tela de etiquetas (chunk próprio).

## Estrutura

```
src/
  App.jsx          ~2.700 linhas — quase todos os componentes e telas.
  api.js           CRUD do Supabase (obras, equipes, agenda, cronogramas, lembretes, diários) + upload das fotos
                   + estoque (leituras paginadas e as chamadas RPC de lançamento/estorno).
  supabase.js      Cria o client a partir das env vars.
  cronograma.js    Motor de agendamento do Cronograma Comercial (dias úteis, dependências).
  agrupamento.js   Chave de agrupamento de obras por cliente (usada pelo App e pelo Diário).
  Modal.jsx        Modal genérico com backdrop.
  PainelLembretes.jsx  Mural de lembretes da coluna direita do calendário.
  ComprasObra.jsx  Compras por categoria da obra: modelo (normCompras), totais e a tela.
  DiarioObra.jsx   Diário de Obras: escolha da obra, caderno, editor do dia e folha impressa.
  FotoMarkup.jsx   Rabisco sobre a foto (seta/caneta/retângulo/texto) + campo de assinatura.
  Estoque.jsx      Estoque: lista, ficha do item, lançar documento, documentos, bloco da obra e as
                   duas folhas impressas (documento e etiquetas).
  Sigilo.jsx       Oculta os valores em R$ do app inteiro até a senha: provider (em main.jsx),
                   <Dinheiro>, <Oculto> e o botão do olho.
  CadastroObra.jsx Campos do cadastro do cliente (o que era a descrição do cartão do Trello).
  AnexosObra.jsx   Anexos da obra: bucket privado, categoria, capa, lixeira, envio múltiplo.
  ComentariosObra.jsx  Coluna de comentários e atividade da obra + autor lembrado no navegador.
  NovoContrato.jsx Popup "+ Novo cliente / contrato" (cliente novo ou contrato de obra existente).
  index.css        CSS global mínimo.
  assets/          Logos.
supabase/
  schema.sql                 Tabelas base + RLS + bucket de Storage.
  migration_ordens.sql       Tabela `ordens` — histórica, sem tela (ver Decisões).
  migration_cronogramas.sql  Tabela `cronogramas` (rodar separado).
  migration_agenda.sql       Tabela `agenda` — serviços do dia (rodar separado).
  migration_equipes_arquivada.sql  Coluna `equipes.arquivada` (rodar separado).
  migration_lembretes.sql    Tabela `lembretes` (rodar separado).
  migration_lembretes_ordem_bigint.sql  Conserta `lembretes.ordem` int → bigint (rodar separado).
  migration_diario.sql       Tabela `diarios` + bucket `diario` (rodar separado).
  migration_estoque.sql      Estoque: tabelas, view de saldo, triggers de imutabilidade e RPCs (rodar separado).
  migration_ficha_obra.sql   Histórico de versões da obra, trigger anti-DELETE em obras, `obra_anexos`,
                             `obra_comentarios` e bucket privado `obras` (rodar separado).
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
| `obras` | `id` (= nº da proposta, texto) | `numero`, `cliente`, `updated_at`, `data` | a obra inteira (itens, etapas, financeiro, compras) + `grupo` (override do agrupamento por cliente) + `cadastro` (ficha do cliente), `checklist` (abertura) e `capa` (`{anexoId, path}`) |
| `equipes` | `id` | `nome`, `integrantes` (jsonb), `cor`, `arquivada` | — (essa não usa `data`) |
| `ordens` | `id` | `numero`, `equipe_id`, `periodo_inicio`, `periodo_fim`, `data` | **histórica** — nenhum código lê ou grava (ver Decisões) |
| `agenda` | `id` | `dia`, `equipe_id`, `obra_id`, `updated_at`, `data` | o serviço do dia: obra (ou avulso) × equipe × período + endereço, referência, descrição e `itens` (ids dos itens da obra que serão montados) |
| `cronogramas` | `id` | `titulo`, `obra_id`, `updated_at`, `data` | o cronograma inteiro (tasks) + `predecessorasMacro` (ids de outros cronogramas) |
| `lembretes` | `id` | `texto`, `prazo`, `arquivado`, `ordem`, `updated_at`, `data` | o lembrete: texto, prazo, obra vinculada, concluído/em andamento/arquivado |
| `diarios` | `id` | `obra_id`, `dia`, `numero`, `updated_at`, `data` | o registro do dia: clima, equipes/presença, atividades, ocorrências, visitas, fotos, assinaturas |
| `obra_anexos` | `id` (uuid) | `obra_id`, `nome`, `path`, `mime`, `tamanho`, `categoria`, `autor`, `created_at`, `removido_em`, `removido_por` | — (**não usa `data`**: uma linha por arquivo) |
| `obra_comentarios` | `id` (uuid) | `obra_id`, `tipo` (`comentario`/`sistema`), `texto`, `autor`, `created_at`, `oculto_em` | — (**não usa `data`**: uma linha por comentário) |
| `obras_historico` | `id` (bigserial) | `obra_id`, `operacao`, `gravado_em`, `data` | a versão anterior da obra, gravada por trigger |
| `profiles` | `id` (= auth.users) | `nome`, `papel` | — |
| `obra_membros` | (`obra_id`,`user_id`) | `papel` | — (**vazia**, fundação para o futuro) |

- `obra_membros` e os papéis `encarregado`/`cliente` existem no schema mas **não são usados**: as
  policies que dariam acesso a eles estão comentadas em `schema.sql`. Hoje só `admin` acessa.
- Todo usuário novo vira `admin` automaticamente (trigger `handle_new_user`).
- Storage: buckets públicos `desenhos` (desenhos técnicos do item) e `diario` (fotos do diário).
  Leitura pública, escrita autenticada. **Leitura pública mesmo**: quem tiver a URL vê a foto.
  O bucket `obras` (anexos: contrato, comprovante, orçamento) é **privado**: só abre por URL
  assinada, que vence em 1 h (`urlsAssinadas` + cache de 50 min em `urlsComCache`). Sem policy de
  update nem de delete — arquivo enviado nunca é sobrescrito nem apagado pelo app.
- `agenda`, `cronogramas`, `lembretes` e `diarios` **não estão no `schema.sql`** — são migrations
  separadas. Se esquecer de rodar, o app não quebra: os `fetch*` correspondentes capturam o erro e
  devolvem `[]`. A exceção é o upload de foto do diário, que falha visível com "Bucket not found"
  até a `migration_diario.sql` rodar.
- `diarios` tem índice **único em (obra_id, dia)**: um registro por obra por dia, e duas abas
  abertas não conseguem criar dois.

### Estoque — a exceção ao padrão `jsonb`

| Tabela | O que é |
|---|---|
| `estoque_itens` | cadastro: `codigo` (EST-00001, único, nunca muda), `nome`, `categoria`, `unidade`, `local`, `estoque_minimo`, `arquivado`, `data jsonb` só para extras |
| `estoque_documentos` | cabeçalho de entrada/saída/ajuste/estorno: `tipo`, `numero` (único por tipo), `motivo`, `dia`, `obra_id` + `obra_rotulo`, `equipe_id`, fornecedor/NF, `responsavel`, `recebido_por`, `obs`, `estorna_id` |
| `estoque_movimentos` | uma linha por item do documento, `quantidade` com sinal (+ entra, − sai), nome e unidade fotografados |
| `estoque_contadores` | numeração dos itens e de cada tipo de documento |
| `estoque_saldos` (view) | saldo = soma dos movimentos. **Nunca gravado.** |

- Documentos e movimentos só têm policy de **SELECT**. Escrita só pelas funções `estoque_lancar`,
  `estoque_estornar` e `estoque_novo_item` (`security definer`, conferem `is_admin()`).
- Triggers dão `raise exception` em UPDATE/DELETE/TRUNCATE de documentos e movimentos — valem até
  para o `service_role` e para o SQL Editor. Item não se apaga, não troca de código e só arquiva com saldo zero.
- `obra_id` sem FK de propósito: a obra pode ser apagada, o documento não.

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
- **Componentes**: por padrão tudo em `App.jsx`, na ordem em que aparece na navegação. Só sai para
  arquivo próprio o que é genérico e reutilizado (`Modal.jsx`, `FotoMarkup.jsx`) ou uma tela inteira
  grande o bastante para afogar o `App.jsx` (`DiarioObra.jsx`, `PainelLembretes.jsx`, `ComprasObra.jsx`
  — ver Decisões).
- **Navegação**: sem router. Estado `view = {type, ...params}` no `App` + pilha `history`.
  `navTo` empilha, `navReplace` troca, `back` desempilha, `goHome` limpa. Todos passam por
  `guardNav`, que intercepta a saída se houver cronograma com gravação pendente.
  Tipos de view: `dashboard`, `obrasPasta` (`pasta: "andamento"|"concluidas"`), `gantt` (`obraId`),
  `print` (`obraId`), `calendar`, `equipes`, `osPrint` (`inicio`, `fim`),
  `cronogramas` (o **macro**: todas as obras, uma por linha), `cronograma` (`id`, o micro de uma
  obra), `financeiro`, `diario` (`obraId` opcional), `diarioPrint` (`obraId`, `inicio`, `fim`),
  `estoque` (`codigo` opcional, vindo do QR), `estoqueDoc` (`docId`), `estoqueEtiquetas` (`itemIds`).
  `calendar`, `diario` e `estoque` navegam por dentro (estado local), sem empilhar view — `DiaAgenda`,
  as três telas do diário e as quatro do estoque são early-returns dos próprios componentes.
  O QR da etiqueta abre `/?item=EST-00012`: o `App` lê o parâmetro uma vez (sobrevive à tela de
  login), abre `{type: "estoque", codigo}` e limpa a URL.
- **Persistência**: o estado local muda na hora; a gravação é **debounced em 700 ms por entidade**
  (`persistObra`, `handleSaveCronograma`, `handleSaveAgendamento`, `handleSaveLembrete`,
  `handleSaveDiario`). A obra ainda passa por fila e trava de versão (ver Decisões). Equipes gravam imediatamente,
  uma por vez (`upsertEquipe`/`deleteEquipe`). O cronograma é o único com indicador de "não salvo"
  (`dirtyCronoIds`), botão Salvar e aviso ao sair. **O estoque não segue nada disso**: todo
  lançamento espera o banco responder e depois relê a lista (`recarregarEstoque`) — ver Decisões.
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

**Compras: categoria → itens → orçamentos.** Desenhado com o setor de compras. Cada categoria
(`obra.compras.perfil|pintura|acessorio|vidro`) tem `naoSeAplica` e uma lista `itens` — a mesma
obra compra vários vidros diferentes. Cada item tem `tipo` (especificação técnica), `estoque`
(`usado: ""|"sim"|"nao"` + `obs`) e uma lista `fornecedores`, que são os **orçamentos** daquele
item. Cada um tem `aprovado`, `orcamento {data, valor, obs}`, `compra {data, valor, obs}`,
`entrega {data, recebido, obs}` e `nf {numero, data}`. Status de orçamento e de item e o "valor
total gasto" são **derivados**, nunca gravados.

`normCompras` aceita três formatos: o atual (`itens`); a v1 de uma semana, com
`tipo`/`estoque`/`fornecedores` direto na categoria (vira um item `it_0`, orçamentos sem a flag
entram aprovados para manter a soma que ela fazia); e o antigo `previsto`/`realizado`/`dataCompra`/
`previsaoEntrega` (vira um item `leg` com as linhas `leg_prev` — aprovada — e `leg_real`). Ids fixos
porque `normObra` roda a cada carga; os totais antigos se mantêm e o registro só troca de formato
na primeira gravação.

**"A comprar" conta o orçamento aprovado; sem aprovação, o mais barato.** Pedir três orçamentos do
mesmo vidro é o normal, e somá-los inflaria o A Pagar e acenderia a 🚩 à toa. Por item: se alguma
linha está aprovada ou comprada, `aComprar` = soma dos orçamentos **aprovados ainda não comprados**
(dois aprovados = compra dividida); senão, o **menor** orçamento do item, como estimativa da
cotação. Uma linha conta como comprada quando a compra tem valor **ou** data, e aí entra em "gasto".
Nunca se subtrai gasto de orçado — na tela antiga (previsto × realizado) subtrair zerava o pendente
sempre que a obra já tinha gasto mais que o previsto restante. Categoria `naoSeAplica` fica fora de
tudo. A flag 🚩 acende quando `aComprar > (valorTotal − valorRecebido)`.

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

**Dias úteis do cronograma são regra da empresa, não do cronograma.** O calendário era seg-**sáb**
e cada cronograma gravava sua cópia de `diasUteis` no `jsonb` — mas nunca houve tela para editá-la,
então era dado morto que só serviria para fazer cronograma antigo e novo discordarem. Hoje
`normConfig` (`cronograma.js`) descarta o valor persistido e impõe o `CONFIG_PADRAO` (seg-sex,
9h/dia). Consequência aceita: cronogramas criados antes esticam ao abrir. Se um dia entrar
calendário por obra ou feriado, o ponto único de mudança é `ehDiaUtil` + `normConfig`.

**O % do grupo é derivado, e defini-lo significa escrever nas folhas.** O percentual de um resumo é
a média das folhas ponderada pelas **horas de duração** (`percentPonderado`) — nunca é gravado.
Para o escritório poder dizer "Suprimentos está 50%", `distribuirPercent` consome o peso na ordem
da lista: 50% de (Metais 4d + Acessórios 2d + Vidros 3d) vira 100/25/0, e não 50/50/50. Descartado
o rateio uniforme: ele ignora que a obra anda em sequência e mostraria Vidros começando junto com
Metais. O arredondamento por folha é corrigido na folha de corte, para o grupo fechar exatamente no
valor pedido.

**Macro e micro leem a mesma verdade: as predecessoras.** A tela `cronogramas` deixou de ser uma
lista de cards e virou o Gantt macro (uma linha por cronograma, `agendarMacro` em ordem topológica).
Ligar "obra B só começa depois da obra A" grava `predecessorasMacro` na obra B; o início efetivo é
**calculado**, nunca gravado — o editor micro recebe `dataBaseEfetiva` como prop e ignora a
`dataBase` própria. Gravar a data derivada teria criado a mesma classe de bug da O.S. antiga: duas
fontes de verdade divergindo em silêncio. A coluna Pred. aceita **números de linha** (ergonomia do
MS Project) mas persiste **ids**, e a lista é ordenada por criação (não pelo `updated_at desc` do
banco), senão os números mudariam sozinhos. Ciclo não trava: as arestas que o fecham são ignoradas
e a tela avisa.

**Obra é um cliente com N contratos, e o agrupamento é só de apresentação.** Duas propostas do
mesmo cliente (BOL #2597 e #2695) são uma obra com dois contratos. Fundir os registros estava fora
de cogitação: o `id` da obra **é** o número da proposta, e agenda, cronograma, lembretes e diário
guardam esse `obraId` — além de os `item.id` serem sequenciais **por obra**, então concatenar itens
faria a O.S. impressa casar item errado. Então cada contrato continua sendo uma obra no banco e
quem agrupa é a tela: `agruparObras` monta o grupo, e Dashboard, as duas pastas e o Financeiro
passam a contar grupos. O **seletor de obra do Diário** também agrupa (a BOL aparecia quatro vezes
seguidas), mas só o card: o caderno continua sendo por contrato, e é uma linha por contrato dentro
do card que abre cada um — o registro do dia amarra num `obra_id` só, e `diarios` tem único em
(obra_id, dia). Calendário, Cronograma e Lembretes seguem contrato a contrato, porque lá é preciso
saber em qual proposta o serviço está sendo lançado.

A chave (`chaveCliente`/`chaveGrupo`) mora em **`src/agrupamento.js`**, não no `App.jsx`: o
`DiarioObra.jsx` precisa dela e importar do `App.jsx` faria ciclo, já que o `App` importa o diário.
Lá também está `agruparSimples`, que só agrupa; `agruparObras`, que consolida financeiro e
progresso, fica no `App.jsx` porque depende de `finObra` e `itemPercentual`.

A chave vem de `chaveCliente` (maiúscula, sem acento, sem LTDA/ME/EIRELI), então grafia diferente
ainda junta. `obra.grupo` é o override: `""` = automático, `"solo:<id>"` = separada à mão, qualquer
outra chave = juntada à mão àquele grupo. É o que resolve homônimo e o inverso, "EDGARD MAX INC."
que não bate com "EDGARD MAX INCORPORADORA LTDA".

Duas consequências deliberadas: **o grupo só vai para Concluídas quando todos os contratos
estiverem concluídos** (enquanto sobra um aberto, a obra não acabou — e o contrato já entregue
aparece dentro de Em Andamento com o selo dele); e **busca e filtro nunca partem o grupo** — se
qualquer contrato casa, o grupo inteiro aparece. Arrastar move o grupo: `handleDrop` achata os
grupos em ids antes de chamar `onReorder`, então os contratos recebem `ordem` consecutivos e não
têm como se separar depois.

Nos consolidados, o financeiro soma **contrato a contrato** via `finObra` e nunca recalcula sobre
valores já somados — o clamp `Math.max(0, total - recebido)` de `finObra` é o que impede o
adiantamento de um contrato mascarar o que o outro tem a receber. O `pct` do grupo é a média sobre
os itens de todos os contratos juntos, não a média das médias.

**A etiqueta do lembrete é derivada, o prazo é o dado.** O painel grava três fatos (`concluido`,
`emAndamento`, `prazo`) e `statusLembrete` deduz o rótulo: concluído > atrasado (prazo vencido e não
concluído) > em andamento > a fazer. Gravar "atrasado" como estado teria criado um campo que envelhece
sozinho e mente no dia seguinte — a mesma classe de problema do % do grupo no cronograma. Lembrete sem
prazo nunca atrasa, de propósito: obriga a escolher entre "tem data" e "é só uma anotação". O "hoje" do
painel vem do relógio **local**, não de `toISOString()`: às 21h no Brasil o ISO já é o dia seguinte e a
etiqueta vermelha acenderia um dia cedo.

**Diário de obra: um registro por obra por dia, nascido da agenda.** A tela não é um formulário em
branco — ao criar o registro, os serviços daquele dia daquela obra são lidos da `agenda` e viram
equipe, integrantes (todos presentes), endereço e a lista de itens. O usuário edita a diferença. É o
mesmo princípio que fez a O.S. sair da agenda: a agenda é a fonte de verdade do que a equipe faz no
dia, e o diário é o *verso* da O.S. — a O.S. é o que vai ser feito, o diário é o que foi feito.
O caderno ainda aponta os dias que têm serviço na agenda e não têm diário. Só a data é obrigatória:
formulário longo com campo obrigatório é formulário não preenchido.

**`responsavel` é campo livre, não vem do login.** Chegou a nascer com `session.user.email` e o
resultado na folha foi `salomaoengenhariapg@gmail.com` — o login é da empresa, não da pessoa que
foi à obra. Enquanto não houver cadastro de pessoas para escolher, é texto digitado. Não religar
no e-mail do login.

**Nem todo dia tem equipe: existe o grupo avulso.** Um item de `diario.equipes` com `equipeId: null`
é um grupo sem cadastro — a vistoria do escritório, você e um funcionário conferindo itens. Ele tem
`rotulo` livre (que vira o nome dele na folha) e os nomes são digitados na hora. Criar uma "equipe"
no cadastro para isso poluiria as escolhas do calendário com algo que nunca vai receber serviço.
O mesmo campo de digitar nome aparece nas equipes cadastradas, para o ajudante emprestado do dia:
`presentes` guarda os nomes, e quem não está no cadastro da equipe é exibido como chip removível.

O modelo é de **prova, não de conformidade**. Não existe obrigação legal genérica de RDO em obra
privada — a Resolução CONFEA 1.094/2017 (Livro de Ordem) foi revogada em 23/11/2023, e a Lei
14.133/2021 art. 117 §1º só obriga o fiscal de contrato público a registrar ocorrências. Por isso
ficaram de fora os campos de construtora tocando obra inteira (concretagem, índice pluviométrico,
horas ociosas de máquina, efetivo por função, cost code, resíduos) e o bloco que sobrou como mais
valioso é o de **ocorrências com responsável (Centauro/Cliente/Terceiro), horas paradas e foto** —
é o que prova que o atraso não foi nosso. Materiais recebidos/avaria estão no modelo de dados
(`materiais: []`) mas ainda sem UI.

**Foto do diário: original no Storage, traços em vetor, achatada para imprimir.** Cada foto guarda
três coisas: `urlOriginal` (a foto crua), `tracos` (o rabisco como vetor no `jsonb`) e `url` (o JPEG
achatado com os traços). O editor reabre original + traços, então dá para desfazer a seta de ontem;
a folha impressa usa a achatada, que é só um `<img>` — canvas na impressão é frágil. As duas gravam
em caminhos diferentes (`<obra>/<diario>/<foto>-orig.jpg` e `<foto>.jpg`) e a achatada leva
`?v=<timestamp>` na URL, senão o navegador continua mostrando a marcação anterior do cache.
Toda foto é reduzida a 1.600px no maior lado antes de subir: foto de celular tem 4–6 MB e o canteiro
é 4G. **Nunca base64 no `jsonb`** — foi para resolver isso que o `seed_supabase.mjs` existiu.

Cada foto tem `tamanho: "normal" | "grande"`, que **só afeta a folha impressa**: normal entra na
grade de duas colunas recortada (`cover`), grande atravessa a largura inteira e sai sem corte
(`contain`, `gridColumn: "1 / -1"`). É por foto, não por documento: numa mesma folha o detalhe do
contramarco sai grande e o resto continua miniatura. `contain` na grande é o ponto — recortar
justamente a foto que existe para ser enxergada anularia a escolha.

**Telas grandes saíram do `App.jsx`.** O diário sozinho passa de 900 linhas; empurrado para dentro,
o `App.jsx` iria a ~4.500 e a cadeia de ternários do despacho ganharia mais um nível. `DiarioObra.jsx`
e `PainelLembretes.jsx` (e depois `ComprasObra.jsx`) são telas inteiras com estado próprio e interface estreita com o `App`
(props de dados + callbacks de gravação), então o custo de separar é zero e o ganho é navegar no
arquivo. `FotoMarkup.jsx` é o caso clássico da regra antiga: genérico e reutilizado (o mesmo canvas
serve o rabisco na foto e a assinatura no dedo). Componentes pequenos continuam no `App.jsx`.

**Equipe é gravada uma por vez.** `saveEquipes` regravava a lista inteira e engolia o erro do
SELECT, então o DELETE muitas vezes nem era enviado e a função resolvia como sucesso — a equipe
sumia da tela e voltava no F5. Agora são `upsertEquipe`/`deleteEquipe`; o delete pede as linhas de
volta (`.select("id")`) e **falha se o banco não apagou nada**, porque um DELETE barrado por RLS
volta 204 sem erro. Se a gravação falhar, a equipe é restaurada na lista em vez de sumir.

**Excluir equipe virou arquivar.** Apagar a linha fazia os serviços já lançados na agenda perderem
a equipe e caírem na faixa "Sem equipe" — sumia o registro de quem fez o quê no mês passado. Hoje o
botão grava `arquivada: true`: a equipe sai das escolhas (líder da obra, "+ Adicionar" do dia) mas
continua no banco, então o dia antigo e a O.S. daquele dia seguem mostrando nome, cor e composição.
Ela reaparece na tela do dia só onde já tem serviço, com selo "arquivada" e sem receber serviço
novo. `deleteEquipe` continua na `api.js` para exclusão manual, mas **nenhuma tela chama**.

**Estoque é livro-razão, não documento `jsonb`.** O pedido foi "itens que jamais podem se perder", e
o padrão do resto do app é justamente o que perde dado: objeto inteiro + upsert debounced deixa uma
aba atrasada gravar um saldo velho por cima do novo, em silêncio. Então aqui: o **saldo nunca é
gravado** (é a soma dos movimentos — mesma regra do % do grupo e da etiqueta do lembrete); documento
e movimento são **imutáveis** (errou, estorna: documento novo com as quantidades invertidas,
apontando para o original, e o histórico mostra os dois); e o lançamento é **uma função no banco**
que grava cabeçalho + linhas numa transação, trava os itens com `select … for update` (em ordem de
id, para não dar deadlock) e **recusa saída maior que o saldo**. Duas pessoas tirando a última
unidade ao mesmo tempo: uma passa, a outra recebe o erro. O saldo negativo foi decisão do usuário:
bloqueia, e diferença física entra por **ajuste de inventário**, que pede justificativa. No ajuste
a tela manda a **contagem**, não a diferença — a função calcula `contagem − saldo` com o item
travado, então uma saída lançada entre abrir a tela e confirmar não estraga a contagem.

A numeração vem de `estoque_contadores`, atualizada dentro da transação. `sequence` do Postgres
pula número quando a transação falha (e saída bloqueada é falha), e buraco em ENT/SAI parece
documento sumido. A obra só fica no documento em "saída para obra" e "devolução de obra" — se uma
compra guardasse obra, o bloco "Saiu do estoque para esta obra" contaria como devolução.

A etiqueta tem QR (URL de produção com `?item=`) e Code128 (só o código). O campo de busca aceita
os dois, e `codigoDoTexto` procura só o `item=`: leitor 2D configurado como teclado americano num
Windows ABNT2 troca `/` e `?`, mas `=` e `-` ficam no lugar. Formatos de etiqueta são uma tabela
em `FORMATOS_ETIQUETA` (mm) com deslocamento X/Y salvo por navegador, porque cada impressora erra
alguns décimos. Etiqueta pequena e quase quadrada (térmica 50×30) põe o código de barras na largura
inteira embaixo do QR: espremido ao lado ele fica fino demais para 203 dpi.

`Exportar CSV` baixa itens e o livro inteiro: é a cópia que fica com a empresa, independente do
plano de backup do Supabase.

**Compras → estoque é um atalho, não uma integração.** O orçamento comprado ganha o botão
"📦 Dar entrada no estoque", que abre a entrada já com fornecedor, NF e data (esta só se estiver
marcado "Entregue" — previsão não é chegada). O item de estoque é escolhido à mão: o `tipo` de
Compras é texto livre de especificação e não casa com cadastro. Ao lançar uma **entrada**, o
orçamento grava `estoqueDoc {id, numero}` (em `normFornecedor`) e o botão vira o nº do documento,
para a mesma compra não entrar duas vezes. A obra fica só na observação do documento: compra com
`obra_id` contaria como devolução no bloco "Saiu do estoque para esta obra". A view chega em
`{type: "estoque", entradaCompra}` e o `EstoqueView` troca por `{type: "estoque"}` com `navReplace`
assim que abre o formulário — senão o "Voltar" da folha impressa reabriria a entrada.

**Obra não perde dado: trava de versão, histórico e nada de DELETE.** O `persistObra` era um upsert
cego — duas pessoas na mesma obra e a última gravação apagava a outra em silêncio. Hoje:
`fetchObras` traz o `updated_at` de cada obra (guardado em `versaoObra`, um ref, fora do `jsonb`);
`salvarObra` faz `update … where updated_at = <versão lida>` e, sem linha de volta, **não grava** —
a obra entra em `conflitos`, a faixa vermelha fica até o usuário clicar "Recarregar" e, até lá, a
obra não grava mais nada. As gravações de uma mesma obra passam por uma fila (`enfileirar`), senão
duas gravações lentas em voo dariam falso conflito; `revObra`/`revSalva` dizem se há alteração que
ainda não chegou ao banco e alimentam o aviso do `beforeunload`. Obra nova é `inserirObra` (INSERT:
proposta repetida é recusada). No banco, `obras_historico` guarda a versão anterior (no máximo uma
a cada 10 min por obra, mais toda troca de itens ou de valor total), e um trigger recusa DELETE em
`obras` — nenhuma tela apaga obra, e apagar exige desligar o trigger à mão.

**Reimportar o PDF só troca itens e valor.** O import antigo substituía a obra inteira e levava
junto compras, financeiro, bandeiras, grupo e as etapas/datas de cada item. `mesclarImportacao`
casa item por `id`, preserva o que o usuário preencheu no item, e o cabeçalho do PDF só preenche
campo vazio. Pergunta antes, e o próprio PDF entra nos anexos como orçamento.

**A ficha da obra saiu do Trello, e comentário e anexo não moram no `jsonb`.** O escritório
guardava descrição, anexos, checklist e comentários num cartão do Trello. Cadastro, checklist e
capa são poucos campos e ficam no `jsonb` (`normObra`). Comentários e anexos **não**: lá valeria
o "última gravação vence" e dois comentários ao mesmo tempo se apagariam. Viraram tabelas próprias,
uma linha por registro, com trigger que recusa DELETE e só deixa mudar `oculto_em` (comentário) ou
`categoria`/`removido_em` (anexo) — mesmo padrão do estoque. Remover anexo é lixeira; o arquivo fica
no Storage. O autor é digitado e lembrado no navegador (`lerAutor`), nunca o e-mail do login — a
mesma decisão do `responsavel` do diário. A atividade automática (`registrarAtividade`: status,
anexos, checklist, obra cadastrada, import do PDF) é um comentário `tipo: 'sistema'`, fire-and-forget.

**Tela da obra em seções recolhíveis.** Cabeçalho fixo (capa, proposta, status, datas) e, abaixo,
`Secao` recolhíveis — Cadastro e Anexos abertas, Checklist, Itens, Compras, Financeiro e Equipe
fechadas — com a coluna de comentários à direita. Fechada, a seção **não monta** (Compras fechada
nem busca o estoque). Aberta/fechada é preferência por navegador (`obra.secao.<id>`).

**Exportar dados.** O menu baixa um JSON com todas as tabelas (`fetchBackupCompleto`), independente
do plano do Supabase. Pede os valores liberados, porque leva o financeiro. Os arquivos em si
(anexos, fotos, desenhos) ficam só no Storage — o backup do banco do Supabase também não os inclui.

## Armadilhas conhecidas

- **`ordem` é `Date.now()`, então a coluna precisa ser `bigint`.** `lembretes` é a única tabela que
  copia o `ordem` do app para uma coluna solta; ela nasceu `int` e recusava todo lembrete novo com
  `value "1788184147925" is out of range for type integer`. A agenda escapou porque lá o `ordem`
  mora só dentro do `jsonb`. Se um dia outra tabela ganhar coluna `ordem`, ela nasce `bigint`.
- **Obra sem `itens` é normal agora** (cadastro manual antes do PDF): `normObra` usa
  `(o.itens || [])`. Código novo que lê itens deve contar com lista vazia.
- **Gravar obra fora do `persistObra`/`criarObra` fura a trava de versão.** Não existe mais
  `upsertObra`; qualquer escrita em `obras` precisa passar pela fila e atualizar `versaoObra`,
  senão a próxima gravação da própria aba vai dar falso conflito.
- **`obras_historico` cresce para sempre** (triggers recusam DELETE). Para podar, desligar o trigger
  `obras_historico_imutavel` à mão no SQL Editor.
- **A senha dos valores (`SENHA_FINANCEIRO`, em `Sigilo.jsx`) é uma constante no código do cliente.**
  Está no bundle publicado; qualquer um lê no devtools. É uma tranca visual, não segurança: os
  valores chegam ao navegador do mesmo jeito. Todo R$ nasce oculto; a mesma senha libera o app
  inteiro (olho da barra do topo, olho do bloco, clique no valor ou a tela Financeiro) até
  recarregar, sair ou clicar no olho de novo. Valor novo na tela passa por `<Dinheiro v={...} />`,
  campo de valor por `<Oculto>`; folha impressa **omite** o valor quando oculto, em vez de imprimir
  a máscara. O CSV de movimentos do estoque sai sem a coluna "Valor unit." quando oculto.
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
- **No editor do diário, mutação lê `ref.current`, render lê a prop `diario`.** O `useEffect` que
  sincroniza o ref só roda depois da pintura, então dois cliques no mesmo ciclo (clicar rápido em
  tempo e praticabilidade) liam a mesma versão antiga e o segundo apagava o primeiro. O `salvar()`
  atualiza o ref **antes** de avisar o pai. Se for adicionar campo novo, siga a regra: `ref.current.x`
  para montar o próximo estado, `diario.x` para exibir.
- **O canvas do rabisco precisa de CORS na foto.** O `<img>` do editor usa `crossOrigin="anonymous"`
  porque sem isso o canvas fica "tainted" e o `toBlob()` do achatamento estoura `SecurityError`.
  O Storage público do Supabase manda `Access-Control-Allow-Origin: *`; se um dia as fotos migrarem
  para bucket privado com URL assinada, esse é o ponto que quebra.
- **TypeScript é decorativo**: `tsconfig.json` existe e `typescript` está nas devDependencies,
  mas o app é todo `.jsx` e não há `tsc` em nenhum script. Idem `vite-plugin-singlefile`, que
  está nas deps mas não é usado no `vite.config.js`.
- **Deploy do Pages às vezes trava na fila** do GitHub (job `deploy` fica em `queued`
  indefinidamente com build já verde). Cancelar o run e disparar de novo resolve.
- **O PostgREST devolve no máximo 1000 linhas e corta calado.** As leituras do estoque passam por
  `todasAsLinhas` (`api.js`), que pagina com `.range()`. As outras tabelas ainda leem sem paginar —
  com mais de 1000 obras ou serviços na agenda, a lista viria truncada sem erro.
- **Etiqueta impressa do localhost aponta para produção** de propósito (`URL_ITEM` em
  `Estoque.jsx`). Para testar o QR no dev, abra `http://localhost:<porta>/?item=EST-00001` à mão.
- **`npm run dev` sobe na 5174 quando a 5173 está ocupada** — o `vite.config.js` não lê `PORT`,
  então a porta que o preview anuncia pode não ser a real. Conferir no log do Vite.
