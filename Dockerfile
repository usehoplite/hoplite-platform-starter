# syntax=docker/dockerfile:1
# Site Studio container image. Build context: the repository root (the example
# is a standalone pnpm workspace with its own lockfile). Google Chrome, which
# the quick accessibility check and browser QA launch (Playwright channel
# "chrome"), is only published for linux/amd64, so build for that platform.
# See README.md, "Deploy".

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
	PATH=/pnpm:$PATH \
	CI=true \
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
	NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# Dependencies, from the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/studio/package.json apps/studio/
RUN --mount=type=cache,id=studio-pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile

# Production build of the studio.
FROM deps AS build
COPY apps/studio apps/studio
RUN cd apps/studio && pnpm build && rm -rf .next/cache

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOME=/home/node \
	STUDIO_LISTEN_HOST=0.0.0.0 \
	STUDIO_LISTEN_PORT=8080 \
	STUDIO_DATA_DIR=/data
# Google Chrome and its system dependencies, installed by the same Playwright
# version the studio uses. Kept in its own layer so code changes reuse it.
COPY --from=deps /app/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/ /opt/playwright-core/
RUN node /opt/playwright-core/cli.js install --with-deps chrome \
	&& rm -rf /opt/playwright-core /var/lib/apt/lists/* /tmp/*
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/studio ./apps/studio
COPY docker-entrypoint.sh /usr/local/bin/studio-entrypoint
RUN mkdir -p /data && chown node:node /data \
	&& chown -R node:node /app/apps/studio/.next
WORKDIR /app/apps/studio
EXPOSE 8080
# The entrypoint makes the mounted volume writable, then runs the server as
# the unprivileged "node" user.
ENTRYPOINT ["studio-entrypoint"]
CMD ["node", "--import", "tsx", "server.ts"]
