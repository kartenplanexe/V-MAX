FROM node:24.15.0-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY index.html vite.config.ts tsconfig.json tsconfig.client.json tsconfig.server.json ./
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24.15.0-alpine AS runtime

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server/index.js"]
