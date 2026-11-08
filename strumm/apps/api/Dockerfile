FROM golang:1.24-bookworm AS ytdl-builder
WORKDIR /src
COPY go-ytdl/ ./
RUN mkdir -p /out && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/strumm-ytdl-go .

FROM node:24-bookworm AS cobalt-builder
WORKDIR /src/cobalt
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN git init \
    && git remote add origin https://github.com/imputnet/cobalt.git \
    && git fetch --depth 1 origin a636575b09de1fc55d9b8cd98cac88f5f2f16b42 \
    && git checkout FETCH_HEAD \
    && corepack enable \
    && pnpm install --prod --frozen-lockfile \
    && pnpm deploy --filter=@imput/cobalt-api --prod /out/api

FROM python:3.11-slim-bookworm

WORKDIR /app

COPY --from=ytdl-builder /out/strumm-ytdl-go /usr/local/bin/strumm-ytdl-go
COPY --from=cobalt-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=cobalt-builder /out/api/ /opt/cobalt/
COPY --from=cobalt-builder /src/cobalt/.git /opt/cobalt/.git

# Install CA certificates for SSL/TLS (required for YouTube Music API in containers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    ffmpeg \
    curl \
    unzip \
    libstdc++6 \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install Python dependencies with pip cache disabled
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN groupadd -r strumm && useradd -r -g strumm -d /app -s /sbin/nologin strumm

# Copy only runtime application code
COPY app/ ./app/
COPY start.sh ./start.sh

# Set ownership
RUN chown -R strumm:strumm /app /opt/cobalt && chmod 755 /app/start.sh

USER strumm

EXPOSE 7860

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
