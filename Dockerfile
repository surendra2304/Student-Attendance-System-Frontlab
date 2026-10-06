# Stage 1: Build Frontend SPA
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
ENV VITE_API_URL=/api
RUN npm run build

# Stage 2: Unified App Runner
FROM python:3.11-slim-bookworm

# Install required system packages for OpenCV (YuNet/SFace) and Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces requires running as user with UID 1000
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860 \
    NODE_ENV=production

WORKDIR /app

# Install AI Service dependencies
COPY ai_service/requirements.txt ./ai_service/
RUN pip install --no-cache-dir -r ./ai_service/requirements.txt

# Install Backend dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy AI Service and Backend code
COPY ai_service/ ./ai_service/
COPY backend/ ./backend/
COPY start.sh ./start.sh

RUN chmod +x start.sh && chown -R user:user /app

USER user

EXPOSE 7860

CMD ["./start.sh"]
