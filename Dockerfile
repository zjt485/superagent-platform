# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY server ./server
COPY web ./web
RUN pnpm --filter @superagent/web build \
 && pnpm --filter @superagent/server build

FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.27.0 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --prod --frozen-lockfile --filter @superagent/server...
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
COPY --from=build /app/server/drizzle ./server/drizzle
RUN useradd --create-home --uid 10001 superagent \
 && mkdir -p /data/workspaces /data/logs \
 && chown -R superagent:superagent /data /app
USER superagent
WORKDIR /app/server
ENV WEB_DIST_DIR=./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
