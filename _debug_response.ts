import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const envPath = path.resolve('/home/geen/Área de trabalho/qwenproxy-main/.env');
const apiKey = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('API_KEY=***            body = JSON.stringify({
  model: 'qwen3.7-plus',
  messages: [{ role: 'user', content: 'ping' }],
  stream: false,
});

const url = new URL('http://localhost:3000/v1/chat/completions');

const req = http.request(
  url,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      process.stdout.write(data);
    });
  },
);
req.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
req.write(body);
req.end();
