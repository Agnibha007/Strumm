FROM python:3.11-slim-bullseye

WORKDIR /app

# Install CA certificates for SSL/TLS (required for YouTube Music API in containers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies with pip cache disabled
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN groupadd -r strumm && useradd -r -g strumm -d /app -s /sbin/nologin strumm

# Copy only runtime application code
COPY app/ ./app/

# Set ownership
RUN chown -R strumm:strumm /app

USER strumm

EXPOSE 7860

CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --limit-concurrency 64 --timeout-keep-alive 15
