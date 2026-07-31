#!/usr/bin/env bash

# Deployment Function & Script for notification-server VPS Deployment

.deploy() {
  local TARGET_IP="${1:-200.141.3.143}"
  local TARGET_PORT="${2:-1300}"
  local TARGET_USER="${VPS_USER:-root}"
  local REMOTE_DIR="${REMOTE_DIR:-/var/www/notification-server}"

  echo "=================================================="
  echo "🚀 Starting Deployment to VPS"
  echo "📡 Server IP   : $TARGET_IP"
  echo "🔌 Port        : $TARGET_PORT"
  echo "👤 SSH User    : $TARGET_USER"
  echo "📁 Remote Dir  : $REMOTE_DIR"
  echo "=================================================="

  # Step 1: Ensure remote directory exists
  echo "📁 Checking remote directory on VPS..."
  ssh -o StrictHostKeyChecking=accept-new "$TARGET_USER@$TARGET_IP" "mkdir -p $REMOTE_DIR"
  if [ $? -ne 0 ]; then
    echo "❌ SSH Connection failed! Please check your SSH access to $TARGET_USER@$TARGET_IP"
    return 1
  fi

  # Step 2: Sync project files using rsync
  echo "📦 Uploading files via rsync..."
  rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude '.history' \
    --exclude 'uploads/*' \
    --exclude '.DS_Store' \
    ./ "$TARGET_USER@$TARGET_IP:$REMOTE_DIR/"

  # Step 3: Remote setup & PM2 restart
  echo "⚙️ Executing server setup and PM2 start on VPS..."
  ssh -o StrictHostKeyChecking=accept-new "$TARGET_USER@$TARGET_IP" "bash -c '
    cd $REMOTE_DIR
    mkdir -p uploads

    if [ ! -f .env ]; then
      echo \"Creating production .env file...\"
      cat << \"ENVFILE\" > .env
PORT=$TARGET_PORT
MONGODB_URI="mongodb+srv://geniusattechie:tF2Oe1CBjJVdL9xZ@cluster0.oxahl6y.mongodb.net/bypss?appName=Cluster0"
MONGO_URL="mongodb+srv://geniusattechie:tF2Oe1CBjJVdL9xZ@cluster0.oxahl6y.mongodb.net/bypss?appName=Cluster0"
API_KEY=monitor
NODE_ENV=production
ENVFILE
    fi

    echo \"📥 Installing dependencies...\"
    npm install --omit=dev

    if ! command -v pm2 &> /dev/null; then
      echo \"⚡ PM2 not found. Installing globally...\"
      npm install -g pm2
    fi

    echo \"🔄 Restarting application with PM2...\"
    if [ -f ecosystem.config.js ]; then
      pm2 reload ecosystem.config.js --env production 2>/dev/null || pm2 start ecosystem.config.js --env production
    else
      pm2 restart notification-server 2>/dev/null || pm2 start server.js --name notification-server --env production
    fi

    pm2 save
    echo \"📊 Application Status:\"
    pm2 status notification-server
  '"

  echo "=================================================="
  echo "🎉 Deployment Completed Successfully!"
  echo "🌐 Backend running at: http://$TARGET_IP:$TARGET_PORT"
  echo "=================================================="
}

# If script is executed directly from command line
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  .deploy "$@"
fi
