# Configuração do Hermes para usar QwenProxy Otimizado

## Configuração Básica

No seu arquivo de configuração do Hermes (geralmente `~/.config/hermes/config.yaml` ou similar), configure o provider customizado:

```yaml
custom_providers:
  qwenproxy:
    base_url: "http://localhost:3000/v1"
    api_key: "***
    models:
      - qwen3.7-plus
      - qwen3.7-max
      - qwen3.6-plus
      - qwen3.5-plus
```

## Configuração Avançada com Session Persistence

Para aproveitar a persistência de sessões, o Hermes precisa enviar um `conversation_id` em cada request. Isso pode ser feito de várias formas:

### Opção 1: Usar Metadata (Recomendado)

Se o Hermes suporta metadata nos requests, configure para enviar um ID único por conversa:

```yaml
# Exemplo de configuração (ajuste conforme suporte do Hermes)
provider_settings:
  qwenproxy:
    metadata:
      conversation_id: "{session_id}"  # Variável que o Hermes substitui
```

### Opção 2: Modificar o Client do Hermes

Se você tem acesso ao código do Hermes ou pode modificar como ele faz requests, adicione:

```typescript
// No código que faz o request para o provider
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ***
  },
  body: JSON.stringify({
    model: 'qwen3.7-plus',
    conversation_id: session.id, // ID único da sessão atual
    messages: messages,
    stream: true
  })
});
```

### Opção 3: Usar Hash Automático (Fallback)

Se não puder enviar `conversation_id`, o QwenProxy gera automaticamente um hash baseado nas primeiras 3 mensagens. Isso funciona bem para conversas que começam de forma similar.

## Configuração do Provider no Hermes

### Para Hermes Agent (Nous Research)

Edite seu `config.yaml`:

```yaml
providers:
  custom:
    qwenproxy:
      type: "openai_compatible"
      base_url: "http://localhost:3000/v1"
      api_key: "***
      default_model: "qwen3.7-plus"
      
      # Configurações opcionais
      timeout: 120000
      max_retries: 3
      
      # Headers customizados (opcional)
      headers:
        X-Custom-Header: "value"
```

### Para Outros Agentes CLI

#### Open Interpreter
```python
# No perfil do Open Interpreter
from interpreter import interpreter

interpreter.llm.api_base = "http://localhost:3000/v1"
interpreter.llm.api_key = "***
interpreter.llm.model = "qwen3.7-plus"

# Para session persistence (se suportado)
interpreter.llm.supports_function_calling = True
```

#### Aider
```bash
# Variáveis de ambiente
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=***

# Ou no .aider.conf.yml
openai-api-base: http://localhost:3000/v1
openai-api-key: ***
model: qwen3.7-plus
```

#### Continue (VS Code)
```json
// ~/.continue/config.json
{
  "models": [
    {
      "title": "Qwen via Proxy",
      "provider": "openai",
      "model": "qwen3.7-plus",
      "apiBase": "http://localhost:3000/v1",
      "apiKey": "***
    }
  ]
}
```

## Otimizações Específicas para Agentes CLI

### 1. Aumentar Context Window

Agentes CLI frequentemente usam muito contexto. Ajuste o model-registry:

```typescript
// src/core/model-registry.ts
const modelContextWindows: Record<string, number> = {
  'qwen3.7-plus': 1000000, // 1M tokens
  'qwen3.7-max': 1000000,
  // ... outros modelos
}
```

### 2. Ajustar Truncamento para Agentes

Agentes precisam preservar tool calls e system prompts:

```typescript
// No chat.ts, ajuste:
const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, modelId, {
  preserveSystemPrompt: true,
  preserveRecentMessages: 20, // Aumentar para agentes
  preserveToolCalls: true
});
```

### 3. Desabilitar Thinking para Respostas Rápidas

Para tarefas simples, desabilite o modo thinking:

```bash
# Usar modelo sem thinking
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus-no-thinking",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 4. Streaming para Melhor UX

Sempre use streaming para agentes CLI:

```json
{
  "model": "qwen3.7-plus",
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

## Monitoramento

### Verificar se Session Persistence está Funcionando

```bash
# Ver logs do servidor
tail -f qwenproxy.log | grep -E "(Reusing|Created new) session"

# Ver estatísticas
curl http://localhost:3000/sessions/stats

# Ver métricas Prometheus
curl http://localhost:3000/metrics
```

### Verificar Performance

```bash
# Tempo de resposta
time curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Hi"}]}'

# Compressão
curl -H "Accept-Encoding: gzip" -I http://localhost:3000/v1/models
```

## Troubleshooting

### Problema: Contexto ainda sendo perdido

**Solução:**
1. Verificar se `conversation_id` está sendo enviado
2. Verificar logs: `[Chat] Reusing existing session`
3. Aumentar `preserveRecentMessages` no `chat.ts`

### Problema: Respostas lentas

**Solução:**
1. Verificar warm pool: `grep "Warmed up" qwenproxy.log`
2. Aumentar `WARM_POOL_SIZE` no `qwen.ts`
3. Verificar se compressão está ativa
4. Verificar connection pooling

### Problema: Rate limiting frequente

**Solução:**
1. Adicionar mais contas: `npm run login`
2. Aumentar `WARM_POOL_SIZE`
3. Verificar cooldowns: `grep "cooldown" qwenproxy.log`

### Problema: Tool calls não funcionando

**Solução:**
1. Verificar se `preserveToolCalls: true` no truncamento
2. Verificar formato das tools no request
3. Testar com tools simples primeiro

## Exemplo Completo de Uso

```bash
# 1. Iniciar servidor
npm start

# 2. Verificar health
curl http://localhost:3000/health | jq .

# 3. Fazer request com session persistence
CONV_ID="my-conversation-$(date +%s)"

curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***
  -d "{
    \"model\": \"qwen3.7-plus\",
    \"conversation_id\": \"$CONV_ID\",
    \"messages\": [
      {
        \"role\": \"system\",
        \"content\": \"Você é um assistente útil.\"
      },
      {
        \"role\": \"user\",
        \"content\": \"Qual é a capital do Brasil?\"
      }
    ],
    \"stream\": true
  }"

# 4. Continuar conversa (mesmo conversation_id)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***
  -d "{
    \"model\": \"qwen3.7-plus\",
    \"conversation_id\": \"$CONV_ID\",
    \"messages\": [
      {
        \"role\": \"system\",
        \"content\": \"Você é um assistente útil.\"
      },
      {
        \"role\": \"user\",
        \"content\": \"Qual é a capital do Brasil?\"
      },
      {
        \"role\": \"assistant\",
        \"content\": \"A capital do Brasil é Brasília.\"
      },
      {
        \"role\": \"user\",
        \"content\": \"E qual é a população?\"
      }
    ],
    \"stream\": true
  }"

# 5. Ver estatísticas
curl http://localhost:3000/sessions/stats | jq .
```

## Benchmarks Esperados

### Sem Otimizações
- Primeiro request: ~2000ms
- Requests subsequentes: ~2000ms (sempre cria nova conversa)
- Contexto: Perdido a cada request

### Com Otimizações
- Primeiro request: ~500ms (warm pool)
- Requests subsequentes: ~100ms (reutiliza sessão)
- Contexto: Preservado entre requests
- **Melhoria: 75-95% mais rápido**

## Suporte

Para problemas ou dúvidas:
1. Verificar `OPTIMIZATIONS.md` para detalhes técnicos
2. Verificar logs do servidor
3. Testar com `test-optimizations.sh`
4. Verificar endpoints de monitoramento
