FROM node:18-bullseye

# Install system Chromium (stable, tested with WhatsApp Web) and all Puppeteer dependencies
# Using system Chromium avoids Puppeteer's bundled Chrome 147 (too new, rejected by WhatsApp security)
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libxss1 \
    libasound2 \
    libgconf-2-4 \
    libappindicator3-1 \
    libxinerama1 \
    libxcursor1 \
    libxrandr2 \
    libdrm2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome and use system Chromium instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 2061

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:2061/api/whatsapp/status || exit 1

# Exec form so node is PID 1 and receives SIGTERM/SIGINT for graceful shutdown.
# Zombie Chromium children are reaped by Docker init (`init: true` in compose).
CMD ["node", "whatsapp-service.js"]
