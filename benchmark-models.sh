#!/bin/bash
set -euo pipefail

PROJECT_DIR="/home/geen/Área de trabalho/qwenproxy-main"
API_URL="http://localhost:3000/v1/chat/completions"
RESULTS_FILE="${PROJECT_DIR}/benchmark_results.csv"

API_KEY="$(grep '^API_KEY=*** "${PROJECT_DIR}/.env" | cut -d'=' -f2- | tr -d '\"' || true)"

export API_URL
export API_KEY
export RESULTS_FILE

"${PROJECT_DIR}/benchmark_models.py"
