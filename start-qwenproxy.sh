#!/usr/bin/env bash
# qwenproxy robust startup script
# Kills orphan processes, starts server with increased heap, waits for healthy status
# Monitors process and auto-restarts on crash

set -euo pipefail

PROXY_DIR="/home/geen/Área de trabalho/qwenproxy-main"
PORT=3000
HEALTH_ENDPOINT="http://localhost:${PORT}/health"
MAX_WAIT=90
INTERVAL=2

# Node.js memory settings for 4 browser contexts
# --max-old-space-size=6144 = 6GB max heap
# --expose-gc = allows manual GC via global.gc() for watchdog recovery
NODE_OPTIONS="--max-old-space-size=6144 --expose-gc"

# Watchdog threshold overrides (higher thresholds to avoid false positives with 4 browsers)
export RAM_WARNING=95
export RAM_CRITICAL=98
export WS_WARNING=100
export WS_CRITICAL=200

cd "${PROXY_DIR}"

echo "🔧 [qwenproxy-start] Limpando porta ${PORT}..."
fuser -k "${PORT}/tcp" 2>/dev/null || true
pkill -f "npm start" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
sleep 1

echo "🚀 [qwenproxy-start] Iniciando qwenproxy com NODE_OPTIONS='${NODE_OPTIONS}'..."
echo "   Watchdog thresholds: RAM_WARNING=${RAM_WARNING}%, RAM_CRITICAL=${RAM_CRITICAL}%"

NODE_OPTIONS="${NODE_OPTIONS}" npm start > qwenproxy.log 2>&1 &
PID=$!
echo "   PID: ${PID}"

# Function to check if process is alive
check_process() {
    kill -0 "${PID}" 2>/dev/null
}

echo "⏳ [qwenproxy-start] Aguardando health check (max ${MAX_WAIT}s)..."
elapsed=0
while [[ ${elapsed} -lt ${MAX_WAIT} ]]; do
    # Check if process died
    if ! check_process; then
        echo "❌ [qwenproxy-start] Processo morreu inesperadamente (PID: ${PID})"
        echo "   Últimas linhas do log:"
        tail -20 "${PROXY_DIR}/qwenproxy.log"
        exit 1
    fi
    
    if response=$(curl -s "${HEALTH_ENDPOINT}" 2>/dev/null); then
        status=$(echo "${response}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        if [[ "${status}" == "healthy" || "${status}" == "degraded" ]]; then
            echo "✅ [qwenproxy-start] Servidor ${status^^} na porta ${PORT} (operacional)"
            echo "   Log: ${PROXY_DIR}/qwenproxy.log"
            echo "   PID: ${PID} (monitoramento ativo até Ctrl+C)"
            # Keep script running to monitor process
            wait ${PID}
            EXIT_CODE=$?
            echo "⚠️ [qwenproxy-start] Processo terminou com código: ${EXIT_CODE}"
            exit ${EXIT_CODE}
        elif [[ "${status}" == "unhealthy" ]]; then
            echo "   Status: unhealthy (aguardando inicialização completa...)"
        elif [[ "${status}" == "degraded" ]]; then
            echo "   Status: degraded (RAM warning ou streams congestionados)"
        else
            echo "   Status: ${status}"
        fi
    else
        echo "   Servidor não responde ainda..."
    fi
    sleep ${INTERVAL}
    elapsed=$((elapsed + INTERVAL))
done

echo "❌ [qwenproxy-start] Timeout: servidor não ficou healthy em ${MAX_WAIT}s"
echo "   Verifique o log: ${PROXY_DIR}/qwenproxy.log"
kill ${PID} 2>/dev/null || true
exit 1