# Monitoramento do Benchmark

## Status: EM EXECUÇÃO

O benchmark está testando 8 modelos com 10 perguntas sequenciais cada (total: 80 requests).

### Modelos sendo testados:
1. qwen3.7-plus
2. qwen3.7-plus-no-thinking
3. qwen3.7-max
4. qwen3.7-max-no-thinking
5. qwen3.6-plus
6. qwen3.6-plus-no-thinking
7. qwen3.6-max-preview
8. qwen3.6-max-preview-no-thinking

### O que está sendo medido:
- **TTFB** (Time To First Byte): latência inicial
- **Tempo total**: tempo completo da resposta
- **Contexto**: se o modelo lembra das perguntas anteriores
- **Taxa de sucesso**: % de requests bem-sucedidos

### Como verificar progresso:
```bash
# Ver output em tempo real
tail -f /home/geen/Área\ de\ trabalho/qwenproxy-main/benchmark_output.log

# Ver resultados parciais
cat /home/geen/Área\ de\ trabalho/qwenproxy-main/benchmark_results.csv

# Ver sessões ativas
curl http://localhost:3000/sessions/stats | jq .
```

### Arquivos de resultado:
- `benchmark_results.csv` - Dados brutos de cada request
- `benchmark_output.log` - Output completo do teste
- `benchmark_report.txt` - Relatório final (gerado ao terminar)
