module.exports = {
  apps: [{
    name: 'qwenproxy',
    script: 'npx',
    args: 'tsx src/index.ts',
    interpreter: 'node',
    interpreter_args: '--max-old-space-size=4096',
    cwd: '/home/geen/Área de trabalho/qwenproxy-main',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    // Memory management - 3.5GB limit
    max_memory_restart: '3500M',
    // Auto-restart on crash
    autorestart: true,
    // Restart delay
    restart_delay: 5000,
    // Max restarts in a minute
    max_restarts: 10,
    min_uptime: 30000,
    // Logging
    output: './logs/pm2-out.log',
    error: './logs/pm2-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Watch for changes (disable in production)
    watch: false,
    // Graceful shutdown
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 30000,
  }]
};