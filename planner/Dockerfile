FROM ghcr.io/astral-sh/uv:0.11.14 AS uv
FROM python:3.12.13-slim
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-cache --python /usr/local/bin/python
COPY src ./src
COPY run.py ./run.py
ENV PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
ENTRYPOINT ["/app/.venv/bin/python", "/app/run.py"]
CMD ["--demo"]
