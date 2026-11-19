FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ICTOB_HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ictob ./ictob
COPY web/scanner ./web/scanner
COPY run_scanner.py ./

# data/ (instrument master + candle cache) and the token file are created at
# runtime; mount a volume at /state and set ICTOB_STATE_DIR=/state to keep a
# daily re-login across restarts.
RUN mkdir -p data/ictob config /state

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz',timeout=4)"

CMD ["python", "run_scanner.py"]
