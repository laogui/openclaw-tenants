module.exports = {
  apps: [
    {
      name: 'openclaw-tenants',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        PORT: '3002',
        FASTIFY_ADDRESS: '0.0.0.0',
        RELAY_MODE: 'relay-server',
        RELAY_WS_PORT: '8080',
        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
        OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || '',
        RELAY_AUTH_TOKEN: process.env.RELAY_AUTH_TOKEN || '',
        TENANT_PREFIX: process.env.TENANT_PREFIX || '',
      },
    },
  ],
}