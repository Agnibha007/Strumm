FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOKAS_PROFILE=0 \
    ENVIRONMENT=production \
    HOME=/home/strumm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

COPY strumm/apps/api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

RUN groupadd --system --gid 10001 strumm \
    && useradd --system --uid 10001 --gid strumm \
       --create-home --home-dir /home/strumm \
       --shell /usr/sbin/nologin strumm

COPY --chown=strumm:strumm strumm/apps/api/app/ /app/app/

USER strumm

EXPOSE 8080

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --limit-concurrency ${UVICORN_LIMIT_CONCURRENCY:-32} --timeout-keep-alive 15"]
