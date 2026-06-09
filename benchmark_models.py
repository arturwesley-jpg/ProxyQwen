#!/usr/bin/env python3
import csv
import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

BASE = Path('/home/geen/Área de trabalho/qwenproxy-main')
ENV = BASE / '.env'
URL = 'http://localhost:3000/v1/chat/completions'


def load_api_key() -> str:
    if not ENV.exists():
        raise SystemExit('.env not found')
    for line in ENV.read_text().splitlines():
        if line.startswith('API_KEY=***            return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise SystemExit('API_KEY missing')


API_KEY = load_api_key()
AUTH = f'Bearer {API_KEY}'
RESULTS_FILE = BASE / 'benchmark_results.csv'
MODELS = [
    'qwen3.7-plus',
    'qwen3.7-plus-no-thinking',
    'qwen3.7-max',
    'qwen3.7-max-no-thinking',
    'qwen3.6-plus',
    'qwen3.6-plus-no-thinking',
    'qwen3.6-max-preview',
    'qwen3.6-max-preview-no-thinking',
]
QUESTIONS = [
    'Qual é a capital da França? Responda em uma frase curta.',
    'Qual rio famoso passa por essa cidade? Responda em uma frase curta.',
    'Em que ano esse rio teve uma enchente histórica famosa? Responda em uma frase curta.',
    'Qual ponte famosa fica nessa cidade? Responda em uma frase curta.',
    'Qual escritor americano famoso viveu nessa cidade nos anos 20? Responda em uma frase curta.',
    'Qual era o nome do café que esse escritor frequentava? Responda em uma frase curta.',
    'Qual movimento literário esse escritor ajudou a fundar? Responda em uma frase curta.',
    'Cite outro escritor importante desse mesmo movimento. Responda em uma frase curta.',
    'Qual obra famosa esse segundo escritor publicou? Responda em uma frase curta.',
    'Em que década essa obra foi publicada? Responda apenas com o ano.',
]
EXPECTED_KEYWORDS = [
    'Paris',
    'Sena',
    '1910',
    'Alejandro',
    'Hemingway',
    'Select',
    'Lost Generation',
    'Fitzgerald',
    'Gatsby',
    '1925',
]

print(datetime.now().strftime('Iniciado em: %Y-%m-%d %H:%M:%S'))
print(f'Modelos: {len(MODELS)} | Perguntas por modelo: {len(QUESTIONS)} | Total: {len(MODELS) * len(QUESTIONS)}')

with RESULTS_FILE.open('w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    writer.writerow(['modelo', 'pergunta_num', 'ttfb_ms', 'total_ms', 'status_code', 'contexto_correto', 'resposta'])
    success = 0
    total = 0
    for model in MODELS:
        conv_id = f'bench-{model}-{int(time.time())}'
        messages = []
        for idx, question in enumerate(QUESTIONS, start=1):
            total += 1
            payload = json.dumps({
                'model': model,
                'conversation_id': conv_id,
                'messages': messages + [{'role': 'user', 'content': question}],
                'stream': False,
            })
            t0 = time.perf_counter()
            try:
                out = subprocess.check_output([
                    'curl', '-s', '--compressed', '--max-time', '120',
                    URL,
                    '-H', 'Content-Type: application/json',
                    '-H', AUTH,
                    '-d', payload,
                ], stderr=subprocess.STDOUT, text=True, timeout=125)
                total_ms = int((time.perf_counter() - t0) * 1000)
                data = json.loads(out)
                msg = data.get('choices', [{}])[0].get('message', {})
                answer = msg.get('content') or msg.get('reasoning_content') or 'ERRO'
                status_code = '200'
                success += 1
            except Exception as e:
                total_ms = int((time.perf_counter() - t0) * 1000)
                answer = f'ERRO: {type(e).__name__}'
                status_code = 'ERROR'
            ctx_ok = 'SIM' if status_code == '200' and EXPECTED_KEYWORDS[idx - 1].lower() in (answer or '').lower() else 'NAO'
            writer.writerow([model, idx, 0, total_ms, status_code, ctx_ok, (answer or '')[:120].replace('\n', ' ')])
            print(f"[{idx}/10] {model} | {total_ms} ms | ctx={ctx_ok} | {(answer or '')[:45].replace(chr(10), ' ')}")
            messages.append({'role': 'user', 'content': question})
            messages.append({'role': 'assistant', 'content': answer or ''})
            time.sleep(1)

print(datetime.now().strftime('\nFinalizado em: %Y-%m-%d %H:%M:%S'))
print(f'Total requests: {total} | Sucesso: {success} | Falhas: {total - success}')
print(f'Resultados detalhados em: {RESULTS_FILE}')
