#!/bin/bash
curl -s --compressed -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***" \
  -d @/home/geen/Área\ de\ trabalho/qwenproxy-main/test_single.json