# Multi-Agent Parallel Execution — Implementation Guide

## O que foi implementado (S1 + S2)

Dois mecanismos complementares para permitir que **múltiplos subagentes rodem em paralelo real** contra o proxy, eliminando o erro `"chat is in progress"`.

### S1 — `X-Account-Id` Header (Pin de Conta)

Cada subagente envia um header HTTP dizendo **qual conta específica** deve usar. O proxy nunca rotaciona essa conta para outra — é um contrato firme.

```
X-Account-Id: acc-geen-01
X-Agent-Id: subagent-1        # opcional, pra observabilidade
```

**Comportamento**:
- Se a conta está livre → usa imediatamente
- Se a conta está ocupada → espera até **30 segundos**
- Se ainda ocupada após 30s → retorna **HTTP 429** com detalhe de quem está segurando

Isso significa: **nunca há auto-rotação pra outra conta**. Cada agente sabe exatamente qual conta é sua.

### S2 — Account Lock (Controle de Concorrência)

Antes de tocar qualquer conta, o proxy **adquire um lock exclusivo** por `accountId`. O lock é liberado automaticamente quando o stream termina (seja sucesso ou erro).

**Comportamento**:
- Lock é um **mutex por conta** — 1 request por vez por conta
- Pedidos subsequentes na mesma conta entram em **fila FIFO**
- Quando a rota é por rotação (sem `X-Account-Id`), contas ocupadas são **puladas automaticamente** para a próxima livre
- Locks "esquecidos" (bug) são limpos pelo watchdog após 5min

### Por que essa combinação funciona

| Cenário | Antes | Agora |
|---------|-------|-------|
| 5 subagentes, 1 conta | 4 falham com "chat in progress" | 4 esperam na fila, executam em sequência |
| 5 subagentes, 5 contas (X-Account-Id) | 4 falham com "chat in progress" | **5 rodam em paralelo real** ✅ |
| 5 subagentes, 10 contas (rotação) | 4 falham com "chat in progress" | 5 pegam contas livres distintas ✅ |

---

## Setup para Hermes (Multi-Agente DevOps Sênior)

### Passo 1 — Adicione 5-10 contas ao proxy

Cada conta Outlook = 1 slot de paralelo. Com 4 contas você tem 4 agentes paralelos. Adicione mais via `accounts.json` ou API.

```json
[
  {"id": "acc-01", "email": "***", "password": "***"},
  {"id": "acc-02", "email": "***", "password": "***"},
  {"id": "acc-03", "email": "***", "password": "***"},
  {"id": "acc-04", "email": "***", "password": "***"},
  {"id": "acc-05", "email": "***", "password": "***"}
]
```

### Passo 2 — Configure `~/.hermes/config.yaml`

Cada subagente usa um **custom_provider próprio**, cada um apontando para uma conta diferente:

```yaml
custom_providers:
  qwen-acc-01:
    base_url: http://localhost:3000/v1
    api_key: ***
    headers:
      X-Account-Id: acc-01
      X-Agent-Id: orchestrator

  qwen-acc-02:
    base_url: http://localhost:3000/v1
    api_key: ***
    headers:
      X-Account-Id: acc-02
      X-Agent-Id: subagent-2

  qwen-acc-03:
    base_url: http://localhost:3000/v1
    api_key: ***
    headers:
      X-Account-Id: acc-03
      X-Agent-Id: subagent-3

  qwen-acc-04:
    base_url: http://localhost:3000/v1
    api_key: ***
    headers:
      X-Account-Id: acc-04
      X-Agent-Id: subagent-4

  qwen-acc-05:
    base_url: http://localhost:3000/v1
    api_key: ***
    headers:
      X-Account-Id: acc-05
      X-Agent-Id: subagent-5

# Delegation config
delegation:
  max_concurrent_children: 5    # 5 subagentes paralelos
  provider: custom:qwen-acc-02  # subagentes usam conta 2 por padrão
  model: qwen3.7-plus-no-thinking
```

O **agente principal** (você no chat) usa `qwen-acc-01`. Os **subagentes delegados** usam `qwen-acc-02` a `qwen-acc-05`.

### Passo 3 — Delegue tarefas

No Hermes:

```
# No chat principal (usa acc-01, thinking model)
> Analise o código do projeto X e faça 3 refatorações em paralelo

# Hermes dispara:
# - subagent-2 → acc-02 (refatoração A)
# - subagent-3 → acc-03 (refatoração B)
# - subagent-4 → acc-04 (refatoração C)
# Tudo em paralelo real, sem contention
```

---

## Padrões Recomendados

### Padrão A — Orquestrador Inteligente + Workers Rápidos

```
Orquestrador (acc-01):
  model: qwen3.7-max (thinking)
  role: planejar, decompor, revisar

Workers (acc-02..05):
  model: qwen3.6-27b-no-thinking (fast)
  role: executar tarefas decompostas
```

**Quando usar**: tarefas complexas que precisam de planejamento (refatorações grandes, debugging, design).

### Padrão B — Todos Iguais

```
Todos os agentes (acc-01..05):
  model: qwen3.7-plus-no-thinking
  role: execução paralela de tarefas independentes
```

**Quando usar**: tarefas embaralháveis (rodar 5 testes em paralelo, buscar 5 coisas, gerar 5 variações).

### Padrão C — Especialistas por Domínio

```
acc-01: orquestrador (thinking model)
acc-02: code-reviewer (coder-plus model)
acc-03: doc-writer (plus model)
acc-04: tester (27b-no-thinking)
acc-05: ops-runner (plus-no-thinking)
```

**Quando usar**: fluxos de trabalho com papéis bem definidos.

---

## Observabilidade

### Ver locks ativos em tempo real

```bash
curl http://localhost:3000/v1/accounts/locks
```

Retorna:
```json
{
  "locks": {
    "acc-01": {
      "owner": "orchestrator:req-abc123",
      "heldForMs": 4500,
      "waiters": 0
    },
    "acc-03": {
      "owner": "subagent-3:req-def456",
      "heldForMs": 12000,
      "waiters": 1   // ← 1 agente esperando!
    }
  },
  "metrics": {
    "activeLocks": 2,
    "totalWaiters": 1,
    "totalAcquires": 145,
    "totalContended": 12,
    "totalTimeouts": 0,
    "contentionRate": 0.082
  }
}
```

### Logs relevantes

```
[Chat] X-Account-Id pinned: acc-03 (agent=subagent-3)     ← S1 ativado
[Chat] Routing request to ... (acc-03) [locked by subagent-3]   ← S2 adquirido
[Chat] Account acc-03 is locked by another request, trying next...   ← S2 rotação
```

---

## Troubleshooting

### "Account X is busy (held by Y). Try again later."

**Causa**: um subagente está segurando a conta por muito tempo (>30s).

**Soluções**:
1. Adicionar mais contas (mais slots paralelos)
2. Usar modelo mais rápido no subagente (ex: `qwen3.6-27b-no-thinking`)
3. Verificar `curl localhost:3000/v1/accounts/locks` pra ver quem está segurando

### "All accounts failed"

**Causa**: todas as contas estão em cooldown (rate limit) ou locked.

**Soluções**:
1. Esperar cooldowns expirarem
2. Adicionar mais contas ao pool
3. Verificar `/v1/accounts/status` pra ver estado de cada conta

### "chat is in progress" (ainda aparece)

**Causa**: 2 requests chegaram quase simultaneamente na mesma conta no intervalo entre release de um e acquire de outro (race condition rara).

**Solução**: verifique que **todos** os custom_providers do Hermes têm `X-Account-Id` distinto. Se estiver usando rotação, o S2 já deveria resolver — abra issue com logs.

---

## Arquitetura Interna

```
Request chega com X-Account-Id: acc-03
            │
            ▼
     [chat.ts] ─────────────────────────────────
            │                                    
            ├─► acquireAccountLock(acc-03)       
            │       │                             
            │       ├─ livre? → lock imediato    
            │       └─ ocupada? → espera 30s     
            │               │                     
            │               └─ timeout → HTTP 429
            │                                    
            ▼ (lock adquirido)                   
     createQwenStream(acc-03)                    
            │                                    
            ▼ (streaming ou non-streaming)       
            │                                    
            ▼                                    
     finally {                                   
       lock.release() ─► libera pra próxima req  
     }                                           
─────────────────────────────────────────────────
```

---

## Arquivos Relevantes

- `src/core/account-lock.ts` — implementação do mutex por conta
- `src/routes/chat.ts` — integração S1 (header) + S2 (lock lifecycle)
- `src/tests/account-lock.test.ts` — 10 testes de comportamento
- `.env.example` — documentação dos headers
- Este arquivo — guia de uso

---

## Próximos Passos (Opcional)

Quando sentir necessidade:

1. **Aumentar timeout de espera** para pinned accounts (hoje 30s, editável em `chat.ts` linha `const lockTimeoutMs`)
2. **Métricas Prometheus** para lock contention rate
3. **Warm pool por conta** pra garantir que cada conta tem sessões pré-criadas
4. **Auto-cleanup** mais agressivo de locks stuck (hoje 5min)

Mas para 95% dos casos de uso multi-agente, a implementação atual já resolve o problema sem nenhum erro de "chat in progress".
