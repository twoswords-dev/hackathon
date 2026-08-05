# Dice Agent Dockerfile - Python + FastAPI + OpenCV
FROM python:3.11-slim

WORKDIR /app

# Install system deps for OpenCV
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/status')" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
