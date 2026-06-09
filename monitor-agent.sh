#!/bin/bash
# Monitora se o agente está trabalhando a cada 5 segundos

echo "=== Monitor de Atividade do Agente ==="
echo "Verificando a cada 5 segundos..."
echo "Pressione Ctrl+C para parar"
echo ""

while true; do
    TIMESTAMP=$(date '+%H:%M:%S')
    
    # Verificar se há processos do Node rodando
    NODE_PROCS=$(pgrep -f "tsx src/index.ts" | wc -l)
    
    if [ $NODE_PROCS -gt 0 ]; then
        echo "[$TIMESTAMP] ✅ Agente TRABALHANDO - $NODE_PROCS processo(s) ativo(s)"
    else
        echo "[$TIMESTAMP] ⚠️  Agente INATIVO - Nenhum processo encontrado"
    fi
    
    # Verificar health do servidor (se estiver rodando)
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        HEALTH=$(curl -s http://localhost:3000/health | jq -r '.status' 2>/dev/null)
        SESSIONS=$(curl -s http://localhost:3000/health | jq -r '.sessions.total' 2>/dev/null)
        echo "           Status: $HEALTH | Sessões: $SESSIONS"
    fi
    
    sleep 5
done
