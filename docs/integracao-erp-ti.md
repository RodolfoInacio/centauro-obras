# Integração ERP → Gestão de Obras

## Chamada

```
POST https://rlyfnlsntlasrwvmgjbo.supabase.co/functions/v1/erp-webhook
Content-Type: application/json; charset=utf-8
Authorization: Bearer <TOKEN>
```

Token vai por WhatsApp.

**Quando enviar:** a cada mudança na obra (pagamento, nota, despesa, lançamento manual, alteração de valor).

**Uma chamada = uma obra**, com o estado completo atual dela (não só o que mudou). Reenviar o mesmo dado não duplica nada — substituímos o que temos daquela obra.

## Formato

- UTF-8
- Valor: `60000.00` — sem `R$`, sem separador de milhar, sem aspas
- Data: `2026-07-28` · Data/hora: `2026-07-28T14:32:00-03:00`
- Campo vazio: `null` ou omitir (não mandar `"N/A"`, `"-"`, `""`)

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
      "id": "DESP-3320",
      "data": "2026-07-22",
      "tipo": "despesa",
      "descricao": "Frete de entrega — Curitiba",
      "valor": 850.00,
      "documento": "CTe 8890",
      "categoria": "Logística"
    }
  ]
}
```

## Campos

### Raiz

| Campo | Tipo | Obrig. | Obs |
|---|---|---|---|
| `proposta` | texto | **sim** | Nº do orçamento. É o que liga ao nosso cadastro |
| `codigo_erp` | texto | não | Código interno do ERP, se houver |
| `atualizado_em` | data/hora | **sim** | Quando o ERP gerou o envio (descartamos envio fora de ordem) |

### `obra`

| Campo | Tipo | Obrig. |
|---|---|---|
| `nome` | texto | não |
| `cliente` | texto | **sim** |
| `cidade` | texto | não |
| `quantidade_itens` | inteiro | **sim** |
| `valor_total` | decimal | **sim** |
| `status` | texto | não — `orcamento` \| `em_andamento` \| `concluida` \| `cancelada` |

### `financeiro`

| Campo | Tipo | Obrig. |
|---|---|---|
| `valor_contratado` | decimal | **sim** |
| `valor_pago` | decimal | **sim** |
| `saldo_devedor` | decimal | **sim** |
| `ultima_movimentacao` | data | não |

Os três valores vêm calculados do ERP. Não recalculamos.

### `extrato` — lista completa da obra

| Campo | Tipo | Obrig. | Obs |
|---|---|---|---|
| `id` | texto | **sim** | Único e estável no ERP (mesmo lançamento = mesmo id sempre) |
| `data` | data | **sim** | |
| `tipo` | texto | **sim** | Ver abaixo |
| `descricao` | texto | **sim** | |
| `valor` | decimal | **sim** | Sempre positivo — o `tipo` define entrada/saída |
| `documento` | texto | não | NF, boleto, CTe |
| `categoria` | texto | não | Classificação/centro de custo |

`tipo`: `pagamento` (recebimento) · `nota` (NF emitida) · `item` (material aplicado) · `despesa` · `lancamento_manual`

## Resposta

| Código | Ação |
|---|---|
| `200` | ok |
| `400` | campo obrigatório faltando ou JSON inválido — corpo traz o motivo. Não repetir |
| `401` | token inválido. Não repetir |
| `500` `502` `503` | falha nossa — repetir com espera crescente (1min, 5min, 15min) |

```json
{ "erro": "campo_obrigatorio_ausente", "detalhe": "financeiro.saldo_devedor" }
```

Proposta que ainda não existe do nosso lado: retornamos `200` e guardamos. Não precisa tratar.

## Perguntas

1. Dá pra disparar por evento ou só em lote?
2. Os 5 tipos de lançamento cobrem o que existe aí?
3. Tem base de homologação pra testar antes de ligar em produção?
