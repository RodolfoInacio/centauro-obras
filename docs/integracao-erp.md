# Integração ERP → Sistema de Gestão de Obras (Centauro Esquadrias)

**Documento de especificação para a equipe de TI do ERP**
Versão 1.0 · Contato técnico: Rodolfo (Centauro Esquadrias)

---

## 1. Objetivo

O Sistema de Gestão de Obras da Centauro acompanha a execução das obras (itens, etapas,
equipes, cronograma). Os dados **financeiros e de faturamento** vivem no ERP.

Queremos que o ERP envie automaticamente três blocos de informação, para que o gestor de obra
enxergue produção e financeiro na mesma tela, sem digitação duplicada:

| Bloco | Informação | Onde aparece no nosso sistema |
|---|---|---|
| **Obra** | nome da obra, quantidade de itens, valor da obra | Tela de gestão da obra |
| **Financeiro** | cliente, saldo devedor, valor já pago | Painel financeiro da obra |
| **Extrato** | itens aplicados, notas, lançamentos manuais, despesas | Extrato detalhado da obra |

---

## 2. Como a integração funciona

**O ERP envia para nós** (webhook). Sempre que houver mudança relevante em uma obra
(pagamento, nota, despesa, lançamento manual, alteração de valor), o ERP faz **uma chamada HTTP**
para o nosso endereço, com os dados daquela obra.

```
ERP  ──── HTTP POST (JSON) ────►  Sistema de Gestão de Obras
```

Não precisamos de acesso ao banco de dados do ERP, e o ERP não precisa nos consultar.

### 2.1 Endpoint

| Item | Valor |
|---|---|
| Método | `POST` |
| URL | `https://rlyfnlsntlasrwvmgjbo.supabase.co/functions/v1/erp-webhook` |
| Content-Type | `application/json; charset=utf-8` |
| Autenticação | Cabeçalho `Authorization: Bearer <TOKEN>` |

> O `TOKEN` é um segredo compartilhado que enviaremos por canal separado (não por e-mail em texto
> aberto). Ele identifica que a chamada veio mesmo do ERP.

### 2.2 Quando enviar

A cada mudança na obra. Se isso for inviável no ERP, aceitamos envio em lote a cada poucas horas —
mas o ideal é o envio por evento, para o financeiro ficar sempre atualizado.

### 2.3 Reenvio é seguro

Cada chamada envia o **estado completo e atual** daquela obra (uma fotografia, não só a diferença).
Isso significa que:

- Reenviar o mesmo dado **não duplica nada** — nós substituímos o que tínhamos daquela obra.
- Se uma chamada falhar, basta reenviar depois; o sistema se autocorrige.
- Não é necessário controlar "o que já foi enviado".

---

## 3. A chave que liga os dois sistemas

**O número da proposta/orçamento** (ex: `2627`) é o identificador comum.

É o mesmo número que aparece no orçamento em PDF gerado pelo sistema comercial e que já usamos
como identificador das obras no nosso sistema. **Esse campo é obrigatório em toda chamada** — sem
ele não conseguimos saber a qual obra o dado pertence.

Se o ERP também tiver um código interno próprio (nº de pedido, contrato), pode enviá-lo em
`codigo_erp` — guardaremos para facilitar conferências, mas o vínculo é feito pela proposta.

---

## 4. Formato dos dados

### 4.1 Regras gerais

| Regra | Detalhe |
|---|---|
| Codificação | UTF-8. A acentuação deve chegar íntegra: `INSTALAÇÃO`, e não `INSTALAÃ‡ÃƒO` |
| Valores monetários | Número com ponto decimal: `60000.00`. **Sem** `R$`, sem separador de milhar, sem aspas |
| Datas | `AAAA-MM-DD` (ex: `2026-07-28`) |
| Data e hora | ISO 8601 com fuso: `2026-07-28T14:32:00-03:00` |
| Campo sem valor | Envie `null` ou omita. Não envie `"N/A"`, `"-"` ou `""` |

### 4.2 Estrutura

```json
{
  "proposta": "2627",
  "codigo_erp": "PED-11875",
  "atualizado_em": "2026-07-30T14:32:00-03:00",

  "obra": {
    "nome": "THE SUNRISE",
    "cliente": "THE SUNRISE EMPREENDIMENTOS IMOBILIARIOS",
    "cidade": "CURITIBA/PR",
    "quantidade_itens": 11,
    "valor_total": 60000.00,
    "status": "em_andamento"
  },

  "financeiro": {
    "valor_contratado": 60000.00,
    "valor_pago": 20000.00,
    "saldo_devedor": 40000.00,
    "ultima_movimentacao": "2026-07-28"
  },

  "extrato": [
    {
      "id": "REC-99871",
      "data": "2026-07-28",
      "tipo": "pagamento",
      "descricao": "Parcela 2/3 — boleto",
      "valor": 20000.00,
      "documento": "NF 4471",
      "categoria": "Recebimento"
    },
    {
      "id": "NF-4471",
      "data": "2026-07-20",
      "tipo": "nota",
      "descricao": "Nota fiscal de venda",
      "valor": 60000.00,
      "documento": "NF 4471",
      "categoria": "Faturamento"
    },
    {
      "id": "DESP-3320",
      "data": "2026-07-22",
      "tipo": "despesa",
      "descricao": "Frete de entrega — Curitiba",
      "valor": 850.00,
      "documento": "CTe 8890",
      "categoria": "Logística"
    },
    {
      "id": "ITEM-771",
      "data": "2026-07-25",
      "tipo": "item",
      "descricao": "Vidro temperado incolor 10mm — 4000x1500",
      "valor": 7427.92,
      "documento": null,
      "categoria": "Material aplicado"
    },
    {
      "id": "LM-556",
      "data": "2026-07-26",
      "tipo": "lancamento_manual",
      "descricao": "Ajuste de medição acordado com cliente",
      "valor": 300.00,
      "documento": null,
      "categoria": "Ajuste"
    }
  ]
}
```

### 4.3 Dicionário de campos

#### Raiz

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `proposta` | texto | **Sim** | Nº da proposta/orçamento. É a chave de ligação |
| `codigo_erp` | texto | Não | Código interno do ERP, se houver |
| `atualizado_em` | data/hora | **Sim** | Momento em que o ERP gerou este envio. Usamos para descartar dados que cheguem fora de ordem |

#### `obra`

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `nome` | texto | Não | Nome da obra |
| `cliente` | texto | **Sim** | Razão social ou nome do cliente |
| `cidade` | texto | Não | Cidade/UF |
| `quantidade_itens` | inteiro | **Sim** | Total de itens da obra |
| `valor_total` | decimal | **Sim** | Valor total contratado |
| `status` | texto | Não | Situação no ERP. Valores sugeridos: `orcamento`, `em_andamento`, `concluida`, `cancelada` |

#### `financeiro`

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `valor_contratado` | decimal | **Sim** | Valor total contratado |
| `valor_pago` | decimal | **Sim** | Quanto o cliente já pagou desta obra |
| `saldo_devedor` | decimal | **Sim** | Quanto falta receber |
| `ultima_movimentacao` | data | Não | Data do último lançamento financeiro |

> Enviem os três valores **já calculados pelo ERP**. Não vamos recalcular a partir do extrato — o ERP
> é a fonte da verdade financeira.

#### `extrato` (lista)

Cada linha é um movimento da obra. **Envie sempre a lista completa da obra**, não apenas os novos.

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `id` | texto | **Sim** | Identificador único e **estável** do lançamento no ERP. Se o mesmo lançamento for reenviado, deve manter o mesmo `id` |
| `data` | data | **Sim** | Data do lançamento |
| `tipo` | texto | **Sim** | Ver tabela abaixo |
| `descricao` | texto | **Sim** | Descrição legível |
| `valor` | decimal | **Sim** | Sempre **positivo**. O `tipo` define se entra ou sai |
| `documento` | texto | Não | Nº da nota, boleto, CTe |
| `categoria` | texto | Não | Classificação/centro de custo do ERP |

**Valores aceitos em `tipo`:**

| `tipo` | Significado | Natureza |
|---|---|---|
| `pagamento` | Recebimento do cliente | Entrada |
| `nota` | Nota fiscal emitida | Faturamento |
| `item` | Item/material aplicado na obra | Custo |
| `despesa` | Despesa lançada na obra (frete, mão de obra, etc.) | Saída |
| `lancamento_manual` | Ajuste lançado manualmente no financeiro | Conforme o caso |

Se o ERP tiver tipos que não se encaixam, nos avise — ampliamos a lista. **Não inventem valores
novos sem combinar**, senão a linha aparece sem classificação na tela.

---

## 5. Resposta e tratamento de erro

| Código | Significado | O que o ERP deve fazer |
|---|---|---|
| `200` | Recebido e processado | Nada. Sucesso |
| `400` | JSON inválido ou campo obrigatório faltando | **Não repetir** — corrigir e reenviar. O corpo traz o motivo |
| `401` | Token ausente ou inválido | **Não repetir** — verificar credencial |
| `429` | Muitas chamadas em pouco tempo | Aguardar e repetir |
| `500` / `502` / `503` | Falha do nosso lado | **Repetir** com espera crescente (ex: 1 min, 5 min, 15 min) |

Exemplo de resposta de erro:

```json
{ "erro": "campo_obrigatorio_ausente", "detalhe": "financeiro.saldo_devedor" }
```

**Obra desconhecida:** se chegar uma proposta que ainda não existe no nosso sistema, nós
**aceitamos e guardamos** (retorno `200`). Os dados aparecem assim que a obra for cadastrada. O ERP
não precisa tratar isso.

---

## 6. Volume esperado

Hoje temos cerca de 60 obras cadastradas, com crescimento de algumas dezenas por ano. O volume de
chamadas é baixo (dezenas por dia, no máximo). Não há necessidade de otimização especial.

---

## 7. Pontos a confirmar com o TI do ERP

1. **O ERP consegue disparar a chamada por evento** (a cada pagamento/nota/despesa), ou só em lote?
2. **O ERP conhece o número da proposta** em todos os registros financeiros? Se em algum caso não
   conhecer, como identificamos a obra?
3. **Os tipos de lançamento** listados no item 4.3 cobrem o que existe no ERP? Falta algum?
4. **Ambiente de testes:** existe uma base de homologação para validarmos antes de ligar em produção?
5. **IP de origem:** qual IP (ou faixa) as chamadas vão partir? Podemos restringir o acesso por IP
   como camada extra de segurança.
6. **Contato técnico** do lado do ERP para acompanhar a implantação.

---

## 8. Próximos passos sugeridos

1. TI do ERP revisa este documento e responde os pontos do item 7.
2. Ajustamos o formato conforme a realidade do ERP (este documento é uma proposta, não uma imposição).
3. Nós disponibilizamos o endpoint e o token de teste.
4. TI envia **uma obra de teste** (sugestão: proposta 2627).
5. Conferimos os dados na tela, validamos e liberamos para produção.
