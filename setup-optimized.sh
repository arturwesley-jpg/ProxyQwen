#!/bin/bash
# Script de instalação e configuração das otimizações

echo "=== Instalando Otimizações do QwenProxy ==="
echo ""

# Verificar se está no diretório correto
if [ ! -f "package.json" ]; then
    echo "❌ Execute este script no diretório do qwenproxy"
    exit 1
fi

# Verificar se Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado. Instale primeiro: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js encontrado: $(node --version)"

# Instalar dependências
echo ""
echo "📦 Instalando dependências..."
npm install

# Instalar Playwright browsers
echo ""
echo "🌐 Instalando Playwright browsers..."
npx playwright install chromium

# Criar diretório de dados se não existir
mkdir -p data

echo ""
echo "✅ Instalação concluída!"
echo ""
echo "=== Próximos Passos ==="
echo ""
echo "1. Configurar credenciais no .env:"
echo "   cp .env.example .env"
echo "   nano .env"
echo ""
echo "2. Fazer login nas contas Qwen:"
echo "   npm run login"
echo ""
echo "3. Iniciar o servidor:"
echo "   npm start"
echo ""
echo "4. Testar otimizações:"
echo "   ./test-optimizations.sh"
echo ""
echo "5. Configurar Hermes/agentes CLI:"
echo "   Ver HERMES_CONFIG.md para detalhes"
echo ""
echo "=== Otimizações Implementadas ==="
echo "✅ Session Persistence (persistência de conversas)"
echo "✅ Estimativa de Tokens Inteligente"
echo "✅ Compressão HTTP (gzip)"
echo "✅ Connection Pooling"
echo "✅ Warm Pool Aumentado (10 chats)"
echo "✅ Truncamento Inteligente"
echo ""
echo "Para mais informações, veja:"
echo "  - OPTIMIZATIONS.md (detalhes técnicos)"
echo "  - HERMES_CONFIG.md (configuração de agentes)"
echo "  - README_OPTIMIZED.md (guia rápido)"
