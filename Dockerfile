FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OB_HOST=0.0.0.0 \
    OB_PORT=8080 \
    PORT=8080

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY scanner_core.py scanner_engine.py site_feed.py tape.py terminal_feed.py \
     universe_fetch.py server.py ./
COPY web ./web
COPY data/sentinel_universe.json ./data/sentinel_universe.json

RUN mkdir -p data/sentinel_cache config

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz',timeout=4)"

CMD ["python", "server.py"]
