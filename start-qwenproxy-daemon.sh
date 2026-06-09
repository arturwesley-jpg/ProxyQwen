#!/usr/bin/env bash
# qwenproxy daemon - robust startup with auto-restart on crash/OOM
# Usage: ./start-qwenproxy-daemon.sh [--foreground]

set -euo pipefail

PROXY_DIR="/home/geen/Área de trabalho/qwenproxy-main"
PORT=3000
HEALTH_ENDPOINT="http://localhost:${PORT}/health"
MAX_WAIT=90
INTERVAL=3
RESTART_DELAY=5
MAX_RESTARTS=10
RESTART_WINDOW=300  # 5 minutes

cd "${PROXY_DIR}"

foregroud_mode=false
if [[ "${1:-}" == "--foreground" ]]; then
    foregroud_mode=true
fi

restart_count=0
window_start=$(date +%s)

cleanup_port() {
    fuser -k "${PORT}/tcp" 2>/dev/null || true
    pkill -f "npm start" 2>/dev/null || true
    pkill -f "tsx src/index.ts" 2>/dev/null || true
    pkill -f "playwright" 2>/dev/null || true
    sleep 2
}

wait_healthy() {
    local elapsed=0
    while [[ ${elapsed} -lt ${MAX_WAIT} ]]; do
        if response=$(curl -s "${HEALTH_ENDPOINT}" 2>/dev/null); then
            status=$(echo "${response}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
            if [[ "${status}" == "healthy" || "${status}" == "degraded" ]]; then
                echo "✅ [daemon] Servidor ${status^^} na porta ${PORT} (operacional)"
                return 0
            elif [[ "${status}" == "unhealthy" ]]; then
                echo "   Status: unhealthy (aguardando estabilizar...)"
            else
                echo "   Status: ${status}"
            fi
        else
            echo "   Servidor não responde ainda..."
        fi
        sleep ${INTERVAL}
        elapsed=$((elapsed + INTERVAL))
    done
    return 1
}

start_proxy() {
    cleanup_port
    
    echo "🚀 [daemon] Iniciando qwenproxy (memória 6GB, GC exposto)..."
    NODE_OPTIONS="--max-old-space-size=6144 --expose-gc" \
    npm start > qwenproxy.log 2>&1 &
    PROXY_PID=$!
    echo "   PID: ${PROXY_PID}"
}

monitor_proxy() {
    local last_health_check=0
    local consecutive_failures=0
    
    while kill -0 ${PROXY_PID} 2>/dev/null; do
        sleep 10
        now=$(date +%s)
        
        # Health check a cada 30s
        if (( now - last_health_check >= 30 )); then
            if response=$(curl -s --max-time 5 "${HEALTH_ENDPOINT}" 2>/dev/null); then
                status=$(echo "${response}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
                if [[ "${status}" == "healthy" || "${status}" == "degraded" ]]; then
                    consecutive_failures=0
                else
                    ((consecutive_failures++))
                    echo "⚠️ [daemon] Health check falhou: ${status} (${consecutive_failures}/3)"
                    if (( consecutive_failures >= 3 )); then
                        echo "❌ [daemon] 3 health checks falharam - reiniciando..."
                        kill ${PROXY_PID} 2>/dev/null || true
                        return 1
                    fi
                fi
            else
                ((consecutive_failures++))
                echo "⚠️ [daemon] Health check falhou - sem resposta (${consecutive_failures}/3)"
                if (( consecutive_failures >= 3 )); then
                    echo "❌ [daemon] 3 health checks falharam - reiniciando..."
                    kill ${PROXY_PID} 2>/dev/null || true
                    return 1
                fi
            fi
            last_health_check=${now}
        fi
    done
    
    # Processo morreu
    wait ${PROXY_PID} 2>/dev/null
    exit_code=$?
    echo "💀 [daemon] Proxy morreu (exit code: ${exit_code})"
    return 1
}

# Trap para limpeza ao sair
cleanup_on_exit() {
    echo ""
    echo "🛑 [daemon] Parando..."
    kill ${PROXY_PID} 2>/dev/null || true
    cleanup_port
    exit 0
}
trap cleanup_on_exit SIGINT SIGTERM

echo "═══════════════════════════════════════"
echo "   qwenproxy DAEMON MODE"
echo "   Auto-restart on crash/OOM enabled"
echo "   Max restarts: ${MAX_RESTARTS} per ${RESTART_WINDOW}s"
echo "═══════════════════════════════════════"

while true; do
    # Rate limiting restarts
    now=$(date +%s)
    if (( now - window_start > RESTART_WINDOW )); then
        restart_count=0
        window_start=${now}
    fi
    
    if (( restart_count >= MAX_RESTARTS )); then
        echo "❌ [daemon] Muitos reinícios (${MAX_RESTARTS}) em ${RESTART_WINDOW}s. Abortando."
        echo "   Verifique logs: ${PROXY_DIR}/qwenproxy.log"
        exit 1
    fi
    
    if (( restart_count > 0 )); then
        echo "🔄 [daemon] Reinício #${restart_count} em ${RESTART_DELAY}s..."
        sleep ${RESTART_DELAY}
    fi
    
    start_proxy
    
    if wait_healthy; then
        echo "✅ [daemon] Proxy estável. Monitorando... (Ctrl+C para parar)"
        if monitor_proxy; then
            echo "✅ [daemon] Proxy parou graciosamente"
            break
        fi
    else
        echo "❌ [daemon] Falha ao atingir healthy em ${MAX_WAIT}s"
        kill ${PROXY_PID} 2>/dev/null || true
    fi
    
    ((restart_count++))
done