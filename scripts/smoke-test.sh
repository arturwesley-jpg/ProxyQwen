#!/usr/bin/env bash
# Smoke test S1+S2: 3 requests paralelos com contas pinadas
# Uso: ./scripts/smoke-test.sh [BASE_URL]
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
API_KEY="${API_KEY:-***

# 3 contas pinadas (primeiras 3 do pool)
ACC_01="bd6d7b5a-e77e-4725-91ee-7ec9bee925dc"
ACC_02="e091f929-a055-4a12-b219-4bd57e7a05f2"
ACC_03="aaec5962-4154-4db2-a3cf-51c7a65aa431"

echo "=== QwenProxy S1+S2 Smoke Test ==="
echo "Base URL: $BASE_URL"
echo "Disparando 3 requests paralelos em contas distintas..."
echo ""

START=$(date +%s%3N)

# Fire 3 parallel requests
for i in 1 2 3; do
  eval ACC=\$ACC_0$i
  (
    T0=$(date +%s%3N)
    RESP=$(curl -sS -w "\n%{http_code}" -X POST \
      "$BASE_URL/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -H "X-Account-Id: $ACC" \
      -H "X-Agent-Id: smoke-$i" \
      -d '{"model":"qwen3.6-27b-no-thinking","messages":[{"role":"user","content":"count 1 to 5 briefly"}],"stream":false}' 2>&1)
    T1=$(date +%s%3N)
    HTTP_CODE=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | sed '$d')
    CONTENT=$(echo "$BODY" | grep -o '"content":"[^"]*"' | head -1 | cut -d'"' -f4 | head -c 80)
    echo "[smoke-$i] acc=${ACC:0:8} | HTTP=$HTTP_CODE | ${T1}ms-${T0}ms=$((T1-T0))ms | $CONTENT..."
  ) &
done

wait

END=$(date +%s%3N)
TOTAL=$((END - START))

echo ""
echo "=== Total: ${TOTAL}ms ==="
echo "(Paralelo real deve ser ~2-3s. Serial seria ~6-9s.)"

echo ""
echo "=== Lock state durante teste: ==="
curl -sS "$BASE_URL/v1/accounts/locks" 2>/dev/null | head -20 || echo "(endpoint não respondeu)"
