FROM node:22-slim

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@11.17.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm --filter @cabo-game/shared build \
    && pnpm --filter @cabo-game/client-core build \
    && pnpm --filter @cabo-game/bot build \
    && pnpm --filter @cabo-game/cli build \
    && pnpm --filter @cabo-game/server build

ENV NODE_ENV=production

EXPOSE 2567

CMD ["pnpm", "--filter", "@cabo-game/server", "start"]
