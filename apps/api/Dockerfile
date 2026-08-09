FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /workspace

RUN groupadd --system fulfilllens \
    && useradd --system --gid fulfilllens --home-dir /workspace fulfilllens

COPY apps/api/requirements.txt ./apps/api/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r apps/api/requirements.txt

COPY apps/api/app ./apps/api/app
COPY data/cases ./data/cases
COPY data/rules ./data/rules
COPY data/schemas ./data/schemas
COPY data/templates ./data/templates

RUN mkdir -p /workspace/data/local \
    && chown -R fulfilllens:fulfilllens /workspace/data/local

USER fulfilllens

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--app-dir", "apps/api", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
