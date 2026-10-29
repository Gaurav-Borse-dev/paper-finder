# ── Stage 1: Build ──
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install all dependencies (including devDeps for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production ──
FROM node:20-slim

# Install native dependencies for canvas and tesseract.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    pkg-config \
    python3 \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy the trained OCR data file
COPY eng.traineddata ./eng.traineddata

# Render injects PORT as env var (default 10000)
ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "dist/index.js"]
