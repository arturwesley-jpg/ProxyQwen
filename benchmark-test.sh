#!/bin/bash
set -euo pipefail

OUT="/tmp/benchmark_results.csv"
API_URL="http://localhost:3000/v1/chat/completions"

: "${API_KEY:=${API_KEY:-}}"
if [[ -z "${API_KEY}" ]]; then
  echo "API_KEY ausente no ambiente do container"
  exit 1
fi

AUTH=*** "${API_KEY}"
HDR=(-H "Content-Type: application/json" -H "Authorization: Bearer ***")

json_for() {
  local model="$1" question="$2" conv="$3"
  cat <<EOF
{
  "model": "$model",
  "conversation_id": "$conv",
  "messages": [{"role": "user", "content": "$question"}],
  "stream": false
}
EOF
}

call() {
  local model="$1" qnum="$2" q="$3" expected="$4" conv="$5"
  local payload
  payload=$(json_for "$model" "$q" "$conv")
  local raw start end elapsed_s elapsed_ms http_code body answer status
  start=$(date +%s%N)
  raw=$(curl -sS --max-time 120 "${HDR[@]}" -d "$payload" "$API_URL" 2>/dev/null || true)
  end=$(date +%s%N)
  elapsed_ms=$(( (end - start) / 1000000 ))

  http_code=$(printf '%s' "$raw" | tr -cd '0-9\n' | tail -n 1 | head -n 1 || true)
  [[ -z "$http_code" ]] && http_code="000"

  body=$(printf '%s' "$raw" | sed -n '$ !p' | sed -n '$ !p' || true)
  [[ -z "$body" ]] && body="$raw"

  answer=$(printf '%s' "$body" | jq -r '.choices[0].message.content // empty' 2>/dev/null || true)
  [[ -z "$answer" ]] && answer=$(printf '%s' "$body" | jq -r '.choices[0].message.reasoning_content // empty' 2>/dev/null || true)
  [[ -z "$answer" ]] && answer="ERRO"

  if [[ "$http_code" == "200" && "$answer" != "ERRO" ]]; then
    if printf '%s' "$answer" | grep -qi "$expected"; then
      status="SIM"
    else
      status="NAO"
    fi
  else
    status="NAO"
  fi

  local safe
  safe=$(printf '%s' "$answer" | tr ',' ';' | tr '"' "'" | tr '\n\r' ' ' | cut -c1-120)
  printf '%s,%s,%s,%s,%s,"%s"\n' "$model" "$qnum" "$elapsed_ms" "$http_code" "$status" "$safe"
  printf '  [P%s] %sms | %s | %s | %s\n' "$qnum" "$elapsed_ms" "$http_code" "$status" "$(printf '%s' "$safe" | cut -c1-60)"
}

run_model() {
  local model="$1"; shift
  local conv="bench-${model}-$(date +%s)"
  local i=1
  for kw in "$@"; do
    call "$model" "$i" "$1" "$kw" "$conv"
    i=$((i+1))
    shift
    sleep 1
  done
  echo
}

main() {
  printf 'model,question_number,response_time_ms,status_code,context_correct,answer\n' > "$OUT"
  local -a models=(
    qwen3.7-plus qwen3.7-plus-no-thinking
    qwen3.7-max qwen3.7-max-no-thinking
    qwen3.6-plus qwen3.6-plus-no-thinking
    qwen3.6-max-preview qwen3.6-max-preview-no-thinking
  )
  local -a keywords=(Paris Sena 1910 Alejandro Hemingway Select "Lost Generation" Fitzgerald Gatsby 1925)
  local -a questions=(
    "Qual e a capital da Franca? Responda em uma frase curta."
    "Qual rio famoso passa por essa cidade? Responda em uma frase curta."
    "Em que ano esse rio teve uma enchente historica famosa? Responda em uma frase curta."
    "Qual ponte famosa fica nessa cidade? Responda em uma frase curta."
    "Qual escritor americano famoso viveu nessa cidade nos anos 20? Responda em uma frase curta."
    "Qual era o nome do cafe que esse escritor frequentava? Responda em uma frase curta."
    "Qual movimento literario esse escritor ajudou a fundar? Responda em uma frase curta."
    "Cite outro escritor importante desse mesmo movimento. Responda em uma frase curta."
    "Qual obra famosa esse segundo escritor publicou? Responda em uma frase curta."
    "Em que decada essa obra foi publicada? Responda apenas com o ano."
  )
  for m in "${models[@]}"; do
    echo "Modelo: $m"
    run_model "$m" "${questions[@]}" "${keywords[@]}"
  done
  echo "CSV: $OUT"
}
main "$@"
