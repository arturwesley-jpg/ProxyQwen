#!/bin/bash
# Script de teste para validar as otimizações do QwenProxy

echo "=== Testando Otimizações do QwenProxy ==="
echo ""

# Verificar se o servidor está rodando
if ! curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "❌ Servidor não está rodando. Inicie com: npm start"
    exit 1
fi

echo "✅ Servidor está rodando"
echo ""

# Testar health check com informações de sessões
echo "1. Testando Health Check..."
HEALTH=$(curl -s http://localhost:3000/health)
echo "$HEALTH" | jq .
echo ""

# Testar estatísticas de sessões
echo "2. Testando Estatísticas de Sessões..."
STATS=$(curl -s http://localhost:3000/sessions/stats)
echo "$STATS" | jq .
echo ""

# Testar compressão
echo "3. Testando Compressão HTTP..."
COMPRESS=$(curl -s -H "Accept-Encoding: gzip" -I http://localhost:3000/health | grep -i "content-encoding")
if [ -n "$COMPRESS" ]; then
    echo "✅ Compressão ativa: $COMPRESS"
else
    echo "⚠️  Compressão não detectada (pode estar desativada para respostas pequenas)"
fi
echo ""

# Testar request com conversation_id
echo "4. Testando Session Persistence..."
CONV_ID="test-conv-$(date +%s)"
echo "Usando conversation_id: $CONV_ID"

RESPONSE1=$(curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***
  -d "{
    \"model\": \"qwen3.7-plus\",
    \"conversation_id\": \"$CONV_ID\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Olá, qual é o seu nome?\"}],
    \"stream\": false
  }")

echo "Primeira resposta:"
echo "$RESPONSE1" | jq '.choices[0].message.content' 2>/dev/null || echo "$RESPONSE1"
echo ""

# Verificar se sessão foi criada
echo "5. Verificando se sessão foi criada..."
STATS_AFTER=$(curl -s http://localhost:3000/sessions/stats)
echo "$STATS_AFTER" | jq .
echo ""

# Testar segundo request com mesmo conversation_id
echo "6. Testando reutilização de sessão..."
RESPONSE2=$(curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***
  -d "{
    \"model\": \"qwen3.7-plus\",
    \"conversation_id\": \"$CONV_ID\",
    \"messages\": [
      {\"role\": \"user\", \"content\": \"Olá, qual é o seu nome?\"},
      {\"role\": \"assistant\", \"content\": \"Olá! Eu sou o Qwen.\"},
      {\"role\": \"user\", \"content\": \"Você lembra o que eu perguntei antes?\"}
    ],
    \"stream\": false
  }")

echo "Segunda resposta (deveria lembrar do contexto):"
echo "$RESPONSE2" | jq '.choices[0].message.content' 2>/dev/null || echo "$RESPONSE2"
echo ""

# Testar limpeza de sessões
echo "7. Testando limpeza de sessões..."
CLEANUP=$(curl -s -X POST "http://localhost:3000/sessions/cleanup?maxAgeDays=0")
echo "$CLEANUP" | jq .
echo ""

echo "=== Testes Concluídos ==="
echo ""
echo "Próximos passos:"
echo "1. Verifique os logs do servidor para ver:"
echo "   - [Chat] Reusing existing session"
echo "   - [Chat] Created new session"
echo "   - [Qwen] Reusing existing chat"
echo ""
echo "2. Monitore performance com:"
echo "   curl http://localhost:3000/metrics"
echo ""
echo "3. Para usar com Hermes, adicione conversation_id nos requests"
