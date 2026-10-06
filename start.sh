#!/bin/bash
set -e

echo "Starting Python AI Face Service on port 8000..."
cd /app/ai_service
python app.py &

echo "Waiting for AI service to initialize..."
sleep 2

echo "Starting Node.js Backend on port 7860..."
cd /app/backend
export PORT=7860
export AI_SERVICE_URL=http://127.0.0.1:8000
exec node src/server.js
