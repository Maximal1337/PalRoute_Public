# PalRoute API — JSON only, no UI.
#
# Build:  docker build -t palroute-api ./backend
# Run:    docker run -p 6969:6969 \
#           -e PALROUTE_CORS_ORIGINS=https://your-frontend.vercel.app \
#           palroute-api

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=6969

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Runtime config only. The dataset itself is built from the lockfile below.
COPY data/expectations.yaml data/profiles.yaml data/sources.lock.json ./data/

# Builds the dataset into the image. Requires network access.
#
# --frozen verifies every download against the committed lockfile and fails the
# build on drift, so the image is reproducible from the lockfile alone.
#
# For an offline build pass --build-arg FETCH_DATA=false and mount a prebuilt
# /app/data instead.
ARG FETCH_DATA=true
RUN if [ "$FETCH_DATA" = "true" ]; then \
      node dist/cli.js data fetch --frozen && \
      node dist/cli.js data build && \
      node dist/cli.js validate; \
    else \
      echo "FETCH_DATA=false — mount a prebuilt dataset at /app/data"; \
    fi

# The graph cache is written at runtime and must be writable by the non-root user.
RUN mkdir -p /app/.cache && chown -R node:node /app/.cache /app/data

USER node
EXPOSE 6969
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6969)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api/server.js"]
