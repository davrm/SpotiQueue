#!/bin/bash
echo "Starting deployment..."
cd /home/davrmassol/SpotiQueue

# Discard any accidental server changes and pull the latest code
git fetch --all
git reset --hard origin/main

# Install Backend
npm install

# Build Public Client
cd client
npm install
npm run build
cd ..

# Build Admin Panel
cd admin
npm install
npm run build
cd ..

# Restart the live server
pm2 restart spotify-queue
echo "Deployment successful!"