FROM python:3.11-slim

WORKDIR /app

# Minimize image size: no apt packages needed (no ffmpeg/yt-dlp)
# Clean apt lists to avoid caching them in a layer
RUN rm -rf /var/lib/apt/lists/*

# Install Python dependencies with pip cache disabled
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy only runtime application code
COPY app/ ./app/

EXPOSE 7860

CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --limit-concurrency 64 --timeout-keep-alive 15
