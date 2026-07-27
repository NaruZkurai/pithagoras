# pi requires Node >= 22.19
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY server server
COPY web web
RUN npm run build

FROM node:22-slim
WORKDIR /app

# git and openssh so pi can work with real repos; ca-certificates for HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent@latest

COPY package.json package-lock.json* ./
COPY server/package.json server/
RUN npm install --omit=dev -w server

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# HOME lives on the data volume so pi packages and settings (~/.pi/agent)
# survive image rebuilds instead of being silently wiped.
ENV NODE_ENV=production \
    PORT=4100 \
    DATA_DIR=/data \
    SESSION_DIR=/data/sessions \
    PROJECT_ROOT=/projects \
    HOME=/data/home
RUN mkdir -p /data/home
EXPOSE 4100
VOLUME /data
CMD ["node", "server/dist/index.js"]
