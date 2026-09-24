FROM ghcr.io/astral-sh/uv:0.11.14 AS uv
FROM node:24.15.0-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY index.html vite.config.ts tsconfig.json tsconfig.client.json tsconfig.server.json ./
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY scripts/copy-server-assets.mjs ./scripts/copy-server-assets.mjs
COPY public ./public
COPY src ./src
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM python:3.12.13-slim-bookworm AS runtime
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY planner/pyproject.toml planner/uv.lock ./planner/
RUN cd planner && uv sync --frozen --no-dev --no-cache --python /usr/local/bin/python
COPY planner/src ./planner/src
COPY planner/run.py ./planner/run.py
COPY --from=build /app/dist ./dist

ENV PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server/index.js"]
