# Scenario B — Answers

## Task 22 — Make it smaller

I created a naive single-stage Dockerfile at `app/Dockerfile.naive` and built it alongside the optimized multi-stage Dockerfile.

```bash
docker build -f Dockerfile.naive -t myapp:v1-naive .
docker build -f Dockerfile -t myapp:v1 .
docker images myapp
```

### Measured image sizes

| Image            | Build type   |       Size | Content size |
| ---------------- | ------------ | ---------: | -----------: |
| `myapp:v1-naive` | Single-stage | **1.7 GB** |       419 MB |
| `myapp:v1`       | Multi-stage  | **245 MB** |      60.4 MB |

The optimized image is **85.6% smaller**:

```text
(1703 - 245) / 1703 × 100 = 85.6%
```

This exceeds the required **60% reduction**.

### What was removed

The multi-stage build creates the application dependencies in a separate build stage and then copies only the required production files into a fresh runtime image.

This removes:

- The larger Debian-based image used by the naive build.
- Build and development tools such as `gcc`, `python3`, `git`, `curl`, and `vim`.
- APT package data and npm cache.
- Unnecessary files from the build environment.
- Development dependencies from the final runtime image.
- Extra build-stage layers and their contents.

Using a separate runtime stage is important because simply deleting files in a later layer would not remove them from the earlier image layers.

### What was given up

The smaller runtime image intentionally has fewer tools available:

- No `curl`, `vim`, or `git` for debugging inside the container.
- No compiler or build toolchain for rebuilding native modules at runtime.
- Alpine uses **musl libc** instead of glibc, which can cause compatibility differences with some native dependencies.
- The container runs as a non-root user, so installing packages or binding to privileged ports at runtime is not possible.
- The multi-stage Dockerfile requires runtime files to be explicitly copied into the final stage.

The current project has no `devDependencies`, so `npm prune --omit=dev` does not provide a significant additional saving yet.

### Verification

Both images were started and tested against `/healthz`:

| Image            | `/healthz` | User   | Healthcheck |
| ---------------- | ---------- | ------ | ----------- |
| `myapp:v1`       | Successful | `node` | Healthy     |
| `myapp:v1-naive` | Successful | `root` | Healthy     |

Both images provide the same application functionality, while the optimized image is significantly smaller and runs as a non-root user.

---

## Task 23 — Layer caching

I added a comment to the end of `app/app.js` and rebuilt the multi-stage image.

| Build           |   Real time |
| --------------- | ----------: |
| Before the edit | **1.885 s** |
| After the edit  | **2.671 s** |

### Layers rebuilt

Changing `app.js` invalidated only the layers that depend on that file:

- `COPY app.js ./` in the build stage.
- The following `RUN npm prune --omit=dev` layer because its parent layer changed.
- `COPY app.js ./` in the final runtime stage.

### Layers that remained cached

The following layers remained cached:

- `FROM node:22-alpine`
- `WORKDIR`
- `COPY package.json package-lock.json`
- `RUN npm ci`
- `COPY --from=build node_modules`
- Runtime `COPY package.json`

### Why this works

The Dockerfile copies `package.json` and `package-lock.json` and runs `npm ci` **before** copying the application source.

Therefore, changing only `app.js` does not invalidate the dependency-installation layer.

If the Dockerfile instead copied the entire application with `COPY . .` before running `npm ci`, even a small source-code change could invalidate the dependency layer and cause dependencies to be installed again.

The cached `npm ci` layer is particularly valuable for larger projects where dependency installation can take significantly longer.

The rebuild therefore demonstrates effective Docker layer caching: **source changes rebuild the necessary application layers without reinstalling unchanged dependencies.**

## Task 24 — Find the biggest layer

I inspected the optimized image using:

```bash
docker history myapp:multi
docker history --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" myapp:multi
```

The largest layer was **156 MB**, which came from the `node:22-alpine` base image and contains the Node.js runtime.

The largest layer created by my own Dockerfile was the `node_modules` layer at **13.9 MB**.

Some files included in the Node base image, such as npm, Node headers, and Yarn, are not required when the application only runs `node app.js`. However, the Node binary itself is required to run the application.

For this task, I kept `node:22-alpine` because it is a supported and relatively small Node.js runtime image.

---

## Task 25 — Prove there are no secrets in the image

The image does not contain real secrets because credentials are provided at **runtime**, not during the image build.

The `.dockerignore` excludes `.env` files, and the Dockerfile only copies the required application files. No credentials are stored in `ARG`, `ENV`, or the application source.

I scanned all image layers using:

```bash
./scripts/scan-image-secrets.sh myapp:multi
```

The scan found:

```text
dotenv files: 0
credential/key files: 0
.npmrc auth tokens: 0
PEM private keys: 0
AWS/GitHub/Slack/OpenAI key formats: 0
connection strings with passwords: 0
hard-coded credentials: 0
```

Result:

```text
RESULT: no secrets found in any layer of myapp:multi
```

I also tested the scanner against an intentionally insecure image containing a fake `.env` file. The scanner correctly detected the secret even though the file had been deleted in a later Docker layer.

This demonstrates that deleting a secret with `rm` does **not** remove it from an earlier Docker layer. The safe approach is to **never copy secrets into the image** and instead provide them at runtime or through Docker/BuildKit secrets.

---

# B2 — Compose, Storage and Debugging

MongoDB is used instead of Postgres (the application already uses the official MongoDB Node.js driver). All commands run from `scenario-b/`. Credentials are supplied at runtime through `.env` (template: `.env.example`); Compose refuses to start if they are missing.

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Fixed stack: `app`, `mongodb`, `prometheus`, `grafana` |
| `prometheus/prometheus.yml` | Scrape config |
| `grafana/provisioning/datasources/prometheus.yml` | Prometheus datasource provisioned automatically |
| `docker/compose.race.yml`, `docker/compose.slow-mongo.yml` | Task 26 broken version |
| `docker/compose.oom.yml`, `compose.split-network.yml`, `compose.bind-mount.yml`, `compose.bind-mount-fixed.yml`, `compose.localhost.yml` | Task 28 experiments |

The app gained a small notes API (`GET /notes`, `POST /notes`) for the persistence test. It returns `503` when MongoDB is not connected. No other behaviour changed.

---

## Task 26 — Compose stack with a real healthcheck

| Service | Image | Host port | Storage |
| --- | --- | --- | --- |
| `app` | built from `app/Dockerfile` | `${APP_PORT:-3100}` → 3000 | — |
| `mongodb` | `mongo:7.0` | not published | named volume `mongo-data` → `/data/db` |
| `prometheus` | `prom/prometheus:v3.5.0` | `127.0.0.1:9090` | named volume `prometheus-data` |
| `grafana` | `grafana/grafana:12.1.1` | `127.0.0.1:3001` | named volume `grafana-data` |

```yaml
mongodb:
  healthcheck:
    test: ["CMD", "mongosh", "--quiet", "--host", "mongodb", "--eval", "quit(db.adminCommand('ping').ok ? 0 : 1)"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 40s
    start_interval: 2s

app:
  depends_on:
    mongodb:
      condition: service_healthy
```

The healthcheck runs a real query (`ping`) and exits non-zero unless `ok` is 1. It uses `--host mongodb` instead of localhost for a reason. On first boot with an empty volume, the image starts a temporary `mongod` bound to `127.0.0.1` to create the root user, then restarts it. A loopback ping succeeds during that window, so the container would be marked healthy before the real server is listening. Pinging both addresses in a loop during first boot confirmed this: loopback answered while the network address was still refused.

### The startup race (broken version)

`docker/compose.race.yml` replaces the dependency with the short form:

```yaml
services:
  app:
    depends_on: !override
      - mongodb
```

The short form means `condition: service_started`: Compose waits only for the MongoDB **container** to start, not for `mongod` to accept connections. The app connects once at startup (`serverSelectionTimeoutMS: 5000`, no retry), so if MongoDB is not listening within 5 seconds, the app stays up but permanently disconnected.

With a normal start the race is intermittent, because it depends on how quickly `mongod` starts. `docker/compose.slow-mongo.yml` delays `mongod` by 20 seconds so the failure is deterministic. The same slow MongoDB is used for the fixed run, so the only difference between the two runs is the `depends_on` condition.

| | Broken (`service_started`) | Fixed (`service_healthy`) |
| --- | --- | --- |
| `docker compose up` | `app Started` right after `mongodb Started` | `mongodb Waiting` → `mongodb Healthy` → `app Started` |
| `docker compose ps` | app `healthy`, mongodb `health: starting` | both `healthy` |
| App log | `MongoDB connection failed: connect ECONNREFUSED <ip>:27017` | `Connected to MongoDB` |
| `GET /` | `"mongodb":"connection_failed"` | `"mongodb":"connected"` |
| `POST /notes` | `503 {"error":"MongoDB unavailable"}` | `201` |

The broken app shows `healthy` because its own healthcheck (`/healthz`) checks only liveness, not the database. It never recovers after MongoDB becomes healthy; only restarting the app fixes it.

**Limitation:** `depends_on` only orders startup under Compose. Production code should also retry the initial connection. The driver already reconnects on its own after an established connection drops.

---

## Task 27 — Persistence with a named volume

MongoDB stores its data in `/data/db`, mounted from the named volume `taskflow-b_mongo-data`. The volume's lifecycle is independent of the container.

```bash
curl -X POST http://localhost:3100/notes -H 'Content-Type: application/json' -d '{"title":"note 1"}'
curl http://localhost:3100/notes
```

| Step | What is removed | Volume | Notes afterwards |
| --- | --- | --- | --- |
| Create 2 notes | — | created | 2 |
| `docker compose down` → `up -d` | containers and network | **kept** | 2 |
| `docker compose down -v` → `up -d` | containers, network **and named volumes** | deleted, recreated empty | 0 |

`down` deletes each container's writable layer but leaves volumes alone. `down -v` also deletes the named volumes declared in the Compose file, so MongoDB starts from an empty data directory and runs first-boot initialisation again. **`down -v` also wipes the Prometheus and Grafana data.**

### Backup and restore

```bash
mkdir -p backups

# Backup: logical dump of the taskflow database as a gzipped archive
docker compose exec -T mongodb sh -c \
  'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db taskflow --archive --gzip' \
  > backups/taskflow.archive.gz

# Restore: --drop replaces existing collections with the backed-up version
docker compose exec -T mongodb sh -c \
  'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --nsInclude "taskflow.*" --drop --archive --gzip' \
  < backups/taskflow.archive.gz
```

- `-T` disables TTY allocation, so the binary archive on stdout/stdin is not corrupted.
- The single-quoted `sh -c` expands the credentials **inside** the container, so the password is never typed on the host or saved in shell history.
- `backups/` is git-ignored because dumps contain application data.

Restore was tested end-to-end: backup → `down -v` → `up -d` (0 notes) → restore → the original notes return with the same `_id` values.

---

## Task 28 — Debugging experiments

Each experiment is an override layered on the fixed file: `docker compose -f docker-compose.yml -f docker/<override> up -d`. Unless stated otherwise, the fix is to run `docker compose up -d` with the base file alone, which recreates the affected service with the correct configuration.

### 28a — Exit code 137 / OOM

- **Cause:** the container's memory limit (64 MiB, swap disabled) is lower than what the process uses. The simulated workload keeps allocating memory until the kernel OOM killer sends `SIGKILL`. Exit code 137 = 128 + 9 (SIGKILL).
- **Symptom:** `docker compose ps -a` shows `Exited (137)`. The logs stop mid-stream with no JavaScript error or stack trace, because SIGKILL cannot be caught. With a restart policy, this becomes a restart loop.
- **Diagnosis:**
  ```bash
  docker inspect --format 'ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} MemoryLimit={{.HostConfig.Memory}}' $(docker compose ps -aq app)
  docker events --since 5m --until 0s --filter container=taskflow-b-app-1 --filter event=oom --filter event=die --format '{{.Action}} exitCode={{index .Actor.Attributes "exitCode"}}'
  docker stats --no-stream
  ```
  `OOMKilled=true` and an `oom` event separate this from other causes of 137, such as `docker kill` or a stop that exceeded its timeout.
- **Fix:** measure real usage with `docker stats` and set the limit above the peak working set (the base file uses `mem_limit: 256m`), then fix the leak itself. Raising the limit alone only delays an unbounded leak.

### 28b — App and MongoDB on different networks

- **Cause:** `app` is only on `frontend`, `mongodb` is only on `backend`. Docker's embedded DNS (`127.0.0.11`) resolves service names only for containers that share a network. `depends_on` still passes because MongoDB is healthy, just unreachable.
- **Symptom:** app log `MongoDB connection failed: getaddrinfo ENOTFOUND mongodb`; `/notes` returns `503`.
- **Diagnosis:**
  ```bash
  docker compose exec app nslookup mongodb          # NXDOMAIN from 127.0.0.11
  docker inspect -f '{{.Name}}: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' $(docker compose ps -q app mongodb)
  docker network inspect taskflow-b_backend --format '{{range .Containers}}{{.Name}} {{end}}'
  ```
- **Fix:** put both services on a shared network (the base file uses `default` for both). Run `docker compose up -d`, then remove the leftover networks with `docker network rm taskflow-b_frontend taskflow-b_backend`.

### 28c — Bind mount hides `/app/node_modules`

- **Cause:** `./app:/app` replaces the image's entire `/app`, including the `node_modules` that `npm ci` installed at build time. `node_modules` is git-ignored, so a fresh clone has none on the host. If the host happens to have its own `node_modules`, the app works by accident ("works on my machine") and can still break when native modules were compiled for the host OS.
- **Symptom:** `Error: Cannot find module 'dotenv'` (`MODULE_NOT_FOUND`); the container is stuck in `Restarting (1)`.
- **Diagnosis:**
  ```bash
  docker compose logs app | grep -E "Cannot find module|MODULE_NOT_FOUND"
  docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' $(docker compose ps -aq app)
  docker compose -f docker-compose.yml -f docker/compose.bind-mount.yml run --rm --no-deps --entrypoint ls app -la /app   # host files, no node_modules
  docker run --rm --entrypoint ls taskflow-b-app /app                                                                   # image does have node_modules
  ```
- **Fix:** `docker/compose.bind-mount-fixed.yml` keeps the bind mount for live source edits and adds an anonymous volume at `/app/node_modules`. The more specific mount wins, and Docker populates the new volume from the image. After changing dependencies, run `docker compose up -d --build -V` to recreate that volume. In production, do not bind-mount source at all.

### 28d — App listens on `127.0.0.1` instead of `0.0.0.0`

- **Cause:** `HOST=127.0.0.1` makes the server listen only on the container's own loopback. Each container has its own network namespace, and published-port traffic arrives on the container's `eth0` address, where nothing is listening.
- **Symptom:** from the host, `curl: (56) Recv failure: Connection reset by peer`. From another container, `Connection refused`. The container still shows **healthy**, because the image's HEALTHCHECK probes `127.0.0.1` from inside.
- **Diagnosis:**
  ```bash
  docker compose logs app                                                  # Server listening on 127.0.0.1:3000
  docker compose exec app netstat -tln                                     # 127.0.0.1:3000, not 0.0.0.0:3000
  docker compose exec app wget -qO- http://127.0.0.1:3000/healthz          # works inside the container
  docker compose exec prometheus wget -qO- -T 3 http://app:3000/healthz    # refused from the network
  ```
- **Fix:** listen on `0.0.0.0` (set in the base file and the Dockerfile). To limit exposure, restrict the published port instead (for example `127.0.0.1:3100:3000`), not the address the app listens on inside the container.
