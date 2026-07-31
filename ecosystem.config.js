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
        PORT: 1300,
        MONGODB_URI: 'mongodb+srv://geniusattechie:tF2Oe1CBjJVdL9xZ@cluster0.oxahl6y.mongodb.net/bypss?appName=Cluster0'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 1300,
        MONGODB_URI: 'mongodb+srv://geniusattechie:tF2Oe1CBjJVdL9xZ@cluster0.oxahl6y.mongodb.net/bypss?appName=Cluster0',
        API_KEY: 'monitor'
      }
    }
  ]
};
