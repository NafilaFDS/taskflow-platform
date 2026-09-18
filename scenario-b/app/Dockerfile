# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 - build
# Installs the full dependency tree (including anything needed to build native
# modules), then strips dev dependencies. Nothing from this stage reaches the
# final image except the pruned node_modules directory.
###############################################################################
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so this layer is cached unless dependencies change.
COPY package.json package-lock.json ./

# npm ci installs exactly what the lockfile pins.
RUN npm ci

COPY app.js metrics.js ./

# Remove dev dependencies so only production packages are carried forward.
RUN npm prune --omit=dev

###############################################################################
# Stage 2 - runtime
# Clean base image. Receives only production node_modules and app source.
# No npm install, no compilers, no build cache.
###############################################################################
FROM node:22-alpine AS runtime

# B4 (Swarm). Passed with --build-arg at build time so each image tag carries
# its own identity: APP_VERSION=v1 / v2 / v3, and BREAK_HEALTHZ=1 only for the
# deliberately broken v3 used in the rollback test (Task 38).
ARG APP_VERSION=dev
ARG BREAK_HEALTHZ=0

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    APP_VERSION=${APP_VERSION} \
    BREAK_HEALTHZ=${BREAK_HEALTHZ}

WORKDIR /app

# The node:alpine images ship a non-root "node" user (uid 1000).
# Files are owned by it so the app never needs root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node app.js metrics.js ./

# Drop privileges. Everything below this line runs as non-root.
USER node

EXPOSE 3000

# Probes /healthz over loopback using the runtime's own node binary,
# so no curl/wget needs to be installed in the final image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http');const port=process.env.PORT||3000;const req=http.get({host:'127.0.0.1',port:port,path:'/healthz',timeout:2500},res=>{process.exit(res.statusCode===200?0:1)});req.on('timeout',()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1))"

CMD ["node", "app.js"]
