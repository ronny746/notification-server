module.exports = {
  apps: [
    {
      name: 'notification-server',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 1300
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 1300,
        MONGODB_URI: 'mongodb://localhost:27017/device_monitor',
        API_KEY: 'monitor'
      }
    }
  ]
};
