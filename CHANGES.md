# Mudanças Implementadas

## Arquivos Criados

- `src/core/session-manager.ts` - Gerenciamento de sessões persistentes (SQLite + cache em memória)

## Arquivos Modificados

### src/routes/chat.ts
- Adicionado import do session-manager
- Extração de `conversation_id` do request body
- Busca de sessão existente antes de criar nova conversa
- Passa `existingChatId` para `createQwenStream` quando sessão existe
- Persiste sessão após sucesso
- Fallback automático: se sessão existente falhar, cria nova sessão

### src/services/qwen.ts
- `WARM_POOL_SIZE`: 5 -> 10 (mais chats pré-criados)
- `WARM_POOL_TTL_MS`: 10min -> 15min
- `createQwenStream` agora aceita `existingChatId` como parâmetro opcional
- Quando `existingChatId` é fornecido, reutiliza o chat em vez de pegar do warm pool

### src/api/server.ts
- Adicionado middleware `compress` (gzip) do Hono
- Import do session-manager
- Health check agora inclui estatísticas de sessões
- Novos endpoints: `/sessions/stats`, `/sessions/cleanup`, `/sessions/:id`
- Limpeza automática de sessões antigas no startup
- Fecha session DB no shutdown

## Como funciona a Session Persistence

1. Cliente envia request com `conversation_id` (ou o proxy gera um automaticamente)
2. Proxy busca no SQLite se já existe uma sessão mapeada para esse `conversation_id`
3. Se existe: reutiliza o `chat_id` do Qwen (mesma conversa = contexto preservado!)
4. Se não existe: cria nova conversa no Qwen e mapeia no SQLite
5. Se a sessão existente falhar (rate limit, erro): fallback para nova sessão automaticamente

## Benefícios

- **Hermes e outros agentes CLI** não perdem mais contexto após poucas mensagens
- **Performance**: requests subsequentes são muito mais rápidos (reutiliza sessão existente)
- **Bandwidth**: compressão gzip reduz tráfego em 60-80%
- **Warm pool maior**: menor latência no primeiro request
