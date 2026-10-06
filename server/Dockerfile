# Stringline API.
#
# Source is baked into the image, never bind-mounted. `docker restart` does not
# pick up changes — every deploy is `docker compose up -d --build`.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# `npm run build` also copies the .sql migrations, which tsc does not emit.
# Using the same script here keeps the image and a local build identical —
# having two build paths is how the migrations went missing the first time.
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Create the upload directory *in the image*, owned by the user that will run.
# Docker seeds a fresh named volume from the image path, ownership included —
# without this the volume is created root-owned and an unprivileged process
# cannot write to it. That failure only appears in a real deployment, never in a
# local run against a developer-owned directory.
RUN mkdir -p /data/uploads && chown -R node:node /data

# Run unprivileged. The node image already ships a `node` user.
USER node
EXPOSE 3006
CMD ["node", "dist/index.js"]
