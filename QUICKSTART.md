# QwenProxy Otimizado - Início Rápido

## O que foi otimizado

1. **Session Persistence** - Conversas são preservadas entre requests (resolve o problema do Hermes perder contexto!)
2. **Compressão HTTP** - Gzip automático reduz bandwidth em 60-80%
3. **Warm Pool Aumentado** - 10 chats pré-criados (era 5) = menor latência
4. **Session Endpoints** - Gerencie sessões via API

## Como usar

```bash
# Iniciar
npm start

# Ver health (agora inclui info de sessões)
curl http://localhost:3000/health | jq .

# Ver estatísticas de sessões
curl http://localhost:3000/sessions/stats | jq .
```

## Enviando conversation_id (RECOMENDADO)

Para aproveitar a session persistence, envie `conversation_id` no request:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***  -d '{
    "model": "qwen3.7-plus",
    "conversation_id": "minha-conversa-123",
    "messages": [{"role": "user", "content": "Olá!"}],
    "stream": true
  }'
```

Requests subsequentes com o mesmo `conversation_id` reutilizarão a mesma conversa no Qwen,
preservando o contexto!

Se você NÃO enviar `conversation_id`, o proxy gera um automaticamente baseado nas primeiras mensagens.

## Configuração no Hermes

No config.yaml do Hermes:

```yaml
custom_providers:
  qwenproxy:
    base_url: "http://localhost:3000/v1"
    api_key: "***
    models:
      - qwen3.7-plus
```

## Endpoints novos

- `GET /sessions/stats` - Estatísticas das sessões
- `POST /sessions/cleanup?maxAgeDays=7` - Limpar sessões antigas
- `DELETE /sessions/:id` - Deletar sessão específica
- `GET /health` - Agora inclui info de sessões

## Performance esperada

| Métrica | Antes | Depois |
|---------|-------|--------|
| Contexto | Perdido | Preservado ✅ |
| Primeiro request | ~2000ms | ~500ms |
| Requests seg. | ~2000ms | ~100ms (reutiliza sessão) |
| Bandwidth | 100% | 20-40% (gzip) |
