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

---

# B3 — Instrumentation, Prometheus and Grafana

## What had to be built first

B2 used MongoDB instead of Postgres, and the app only had `/`, `/healthz` and `/notes`. B3 depends on the multi-tenant Notes API and its four deliberate problems, so they were added to the existing Express + MongoDB app (same language, framework, database and compose stack). The B2 routes still work.

| Exam (Postgres) | This project (MongoDB) |
| --- | --- |
| tables `tenants`, `notes`, `tags` | collections `tenants`, `notes`, `tags` (integer `_id`s, `tenant_id`, `note_id`) |
| seeder with `generate_series` | `seed/seed.js` (mongosh): 5 tenants, 50,000 notes (acme 30,000, others 5,000 each), 150,000 tags. Runs in 3.5 s |
| `WHERE tenant_id = $1` | every query filters by `tenant_id`; tenant comes from `X-Tenant` |
| `LIKE '%word%'` | unanchored `$regex` (no index can serve it) |
| `EXPLAIN ANALYZE` | `explain("executionStats")`: it also runs the query and reports rows, keys and documents examined, and time |
| `pg_relation_size('idx_tags_note_id')` | `db.tags.stats().indexSizes.idx_tags_note_id` |

Deliberate problems (left in until Task 34):

1. **N+1**: `GET /api/notes` runs one query for the notes, then one `tags.find({note_id})` per note (limit=20 → 21 queries).
2. **Unindexed search**: `GET /api/search` uses a regex on `body`, so every search scans all 50,000 notes.
3. **Missing index on `tags.note_id`**: every tag lookup scans all 150,000 tags. This makes the N+1 and `/api/stats` slow.
4. **Unbounded limit**: `?limit=5000` is accepted and returns 5,000 notes.

```bash
# seed (from scenario-b/; credentials are expanded inside the container)
docker compose exec -T mongodb sh -c \
  'cat > /tmp/seed.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/seed.js' \
  < seed/seed.js
```

| File | Purpose |
| --- | --- |
| `app/app.js` | multi-tenant API, `/readyz`, `/metrics`, JSON error handler |
| `app/metrics.js` | prom-client metrics, request middleware, DB query wrapper |
| `seed/seed.js` | seeder (the deliberately broken baseline) |
| `seed/fix-idx-tags-note-id.js` | Task 34 fix (index migration) |
| `seed/task34-measure.js` | Task 34 explain, index size and insert timing |
| `prometheus/prometheus.yml` | scrape job for `app:3000` |
| `grafana/provisioning/datasources/prometheus.yml` | Prometheus datasource, fixed uid `prometheus` |
| `grafana/provisioning/alerting/p95-latency.yml` | Task 33 alert rule |
| `grafana/dashboard.json` | exported dashboard `exam-$EXAM_TOKEN` |
| `scripts/grafana.sh` | creates the dashboard from `$EXAM_TOKEN`, exports it, adds annotations |
| `loadtest.sh` | Task 31 load generator |
| `evidence/b3-task34-before.txt`, `evidence/b3-task34-after.txt` | raw Task 34 measurements |

**Test machine:** MacBook Air, Docker Desktop with 8 CPUs, running on battery with **Low Power Mode on** for all recorded runs. Absolute timings on another machine will differ. The same scan took 52 ms in an earlier measurement and 98 ms under Low Power Mode. All before/after comparisons below were made in the same power state.

**Port:** host port 3000 is used by another local process, so the app is published on `APP_PORT=3100`. Inside Docker it listens on 3000, which is what Prometheus scrapes. On a machine where 3000 is free, set `APP_PORT=3000`.

---

## Task 29 — Application metrics

Client library: `prom-client` 15 (`app/package.json`). Endpoint: `GET /metrics`.

| Metric | Type | Labels | Where it is recorded |
| --- | --- | --- | --- |
| `http_requests_total` | Counter | `route`, `method`, `status`, `tenant` | Express middleware, when the response finishes |
| `http_request_duration_seconds` | Histogram | `route`, `method`, `tenant` | same middleware |
| `db_query_duration_seconds` | Histogram | `query_name` | `timedQuery()`, which wraps every MongoDB call |
| `db_queries_per_request` | Histogram | `route` | queries counted per request with AsyncLocalStorage, observed at the end |
| `db_rows_returned` | Histogram | `query_name` | `timedQuery()`: array length, or 1/0 for single results |
| `http_requests_in_flight` | Gauge | none | +1 when a request starts, −1 when it ends |

Design decisions:

- **Route label = pattern.** It comes from Express `req.route.path` (`/api/notes/:id`), never from the URL (`/api/notes/48213`). Unknown paths get `route="unmatched"`.
- **Tenant label is bounded.** A tenant slug is only used as a label after it is found in the database. A missing header becomes `none` and an unknown one becomes `unknown`, so a client sending random `X-Tenant` values cannot create new series.
- **Errors are counted with their real status.** Validation errors return 400 and unknown notes or tenants return 404. A JSON error handler records 500. A client that disconnects is recorded as 499. The JSON body parser runs after routing, so a malformed body is recorded as 400 on its real route, not as `unmatched`.
- **Request time budget (15 s, `REQUEST_TIMEOUT_MS`).** With the deliberate problems, one `?limit=5000` request would run 5,000 full scans of `tags`, about 260 s at the measured 52 ms each. `timedQuery()` refuses to start new queries after 15 s, and the request fails with **504**. This does not fix any problem (the N+1 and the unbounded limit still run). It keeps load tests bounded and turns the heavy tenant's pain into real 5xx errors.
- **Buckets were chosen from measured data.**
  - `db_query_duration_seconds`: doubling from 0.25 ms to 4 s.
  - `http_request_duration_seconds`: up to 60 s, with a boundary at 16 s just above the 15 s budget.
  - `db_queries_per_request`: boundaries at n+0.5, so `histogram_quantile` returns exactly 21 for the N+1.

Verification (`curl -s localhost:3100/metrics | head -50`, first lines, after traffic):

```text
# HELP http_requests_total HTTP requests handled, by route pattern, method, status code and tenant
# TYPE http_requests_total counter
http_requests_total{route="/healthz",method="GET",status="200",tenant="none"} 65
http_requests_total{route="/api/notes",method="GET",status="200",tenant="acme"} 429
http_requests_total{route="/api/notes/:id",method="GET",status="200",tenant="acme"} 65
http_requests_total{route="/api/notes/:id",method="GET",status="404",tenant="hooli"} 49
http_requests_total{route="/api/search",method="GET",status="200",tenant="acme"} 65
http_requests_total{route="/api/stats",method="GET",status="200",tenant="acme"} 65
...
# HELP http_request_duration_seconds HTTP request latency in seconds, by route pattern, method and tenant
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.005",route="/healthz",method="GET",tenant="none"} 65
```

Error paths were tested with real requests before any load. Resulting series include `status="504",tenant="acme"` (limit=5000, 15.06 s, 277 queries), `status="499",tenant="globex"` (client gave up after 2 s), `status="400",tenant="none"` (missing `X-Tenant`), `status="404",tenant="unknown"` and `route="unmatched"`.

Log lines (one per request, `docker compose logs app`):

```text
2026-09-17T14:04:01.978Z GET /api/notes?limit=5000 route=/api/notes tenant=acme status=504 duration_ms=15056.5 db_queries=277
2026-09-17T14:41:55.952Z GET /api/notes?limit=20 route=/api/notes tenant=acme status=200 duration_ms=45.2 db_queries=22
2026-09-17T14:41:56.406Z GET /api/stats route=/api/stats tenant=hooli status=200 duration_ms=52.6 db_queries=2
2026-09-17T14:41:58.202Z GET /api/notes?limit=5000 route=/api/notes tenant=acme status=200 duration_ms=1696.1 db_queries=5001
```

---

## Task 30 — Prometheus

`prometheus/prometheus.yml` is mounted read-only into the `prometheus` container (`127.0.0.1:9090:9090`, `restart: unless-stopped`, named volume `prometheus-data`, so it survives restarts):

```yaml
  - job_name: taskflow-app
    scrape_interval: 5s
    metrics_path: /metrics
    static_configs:
      - targets: ["app:3000"]
```

`app` is the compose service name, resolved by Docker DNS on the shared project network. `3000` is the container port, not the host port 3100. The 5 s interval gives enough samples for 1-minute rates during a 5-minute test.

Verification:

```text
GET /api/v1/targets
{"job":"taskflow-app","scrapeUrl":"http://app:3000/metrics","health":"up","lastScrapeDuration":0.017235209}

query: sum by (route) (http_requests_total{job="taskflow-app"})
/api/notes 660   /api/notes/:id 297   /api/search 296   /api/stats 297   /healthz 65
```

Scrapes stayed `up` even at 54 in-flight requests. The slowest scrape took 1.18 s.

---

## Task 31 — Load generation

```bash
cd scenario-b
./loadtest.sh            # 5 minutes, Ctrl-C stops everything and still prints the summary
```

`loadtest.sh` needs only bash and curl. All traffic runs at the same time:

| Traffic | What | When |
| --- | --- | --- |
| normal | every 2 s, for a random tenant out of **acme, globex, initech, umbrella, hooli**: `/api/notes?limit=20`, `/api/search?q=abc`, `/api/stats`, `/api/notes/1` | whole run (open loop: new rounds start even when the app is slow) |
| heavy tenant | **acme** only, `/api/notes?limit=5000`, one request after another | from t+60 s. The first minute is a clean baseline |
| burst | an extra normal-traffic loop every 0.5 s (4× the rate) | t+135 s to t+165 s (30 s) |

Curl bodies go to `/dev/null`. Each request writes one line to a temp file, and the summary is computed from it. The load was sized from calibration runs. At one round per second with 2–3 heavy workers, MongoDB saturated and every tenant slowed down, which hid which tenant caused it.

Recorded run (before the Task 34 fix), output unchanged:

```text
[20:32:30 t+0s] load test against http://localhost:3100 for 300s
[20:32:30 t+0s] normal: 4 requests every 2s across tenants: acme globex initech umbrella hooli
[20:32:30 t+0s] heavy:  1 workers from t+60s, tenant=acme, /api/notes?limit=5000
[20:32:30 t+0s] burst:  1 extra loops every 0.5s from t+135s to t+165s
[20:33:30 t+60s] heavy tenant started
[20:34:45 t+135s] burst started
[20:35:16 t+166s] burst finished
[20:37:30 t+300s] duration reached, waiting for in-flight requests

================ load test summary ================
base url     http://localhost:3100
ran for      303s (planned 300s)
started      20:32:30
heavy from   20:33:30
burst        20:34:45 - 20:35:15
requests     832

-- by endpoint --
key                      requests    avg_s    p95_s    max_s  statuses
/api/notes/1                  204    0.111    0.364    1.978  404x173 200x31
/api/notes?limit=20           204    7.052   16.353   17.374  504x57 200x147
/api/notes?limit=5000          16   15.151   15.898   15.898  504x16
/api/search?q=abc             204    0.299    1.079    1.754  200x204
/api/stats                    204    1.325    4.487    8.042  200x204

-- by tenant --
key                      requests    avg_s    p95_s    max_s  statuses
acme                          140    3.474   15.124   16.993  504x21 200x119
globex                        156    2.444   15.950   17.374  404x39 504x14 200x103
hooli                         172    1.776   15.141   16.596  404x43 504x10 200x119
initech                       212    2.103   15.431   16.719  404x53 504x14 200x145
umbrella                      152    2.737   15.610   16.882  404x38 504x14 200x100

-- by phase --
key                      requests    avg_s    p95_s    max_s  statuses
burst                         224    4.708   16.308   17.374  404x52 504x45 200x127
heavy                          16   15.151   15.898   15.898  504x16
normal                        592    1.247    3.810   16.440  404x121 504x12 200x459
```

The 404s are correct: note 1 belongs to acme, so other tenants get "note not found". The 504s of the other tenants all happened during the 30 s burst (see Panel H).

---

## Task 32 — Grafana dashboard

Grafana 12.1.1 on `127.0.0.1:3001`. Login is `admin` with the password from `.env` (`GRAFANA_ADMIN_PASSWORD`), as set up in B2, instead of admin/admin. The Prometheus datasource is provisioned. The dashboard is created with the token taken from the environment, never hard-coded:

```bash
./scripts/grafana.sh dashboard   # POST grafana/dashboard.json with title "exam-$EXAM_TOKEN"
./scripts/grafana.sh export      # save the live JSON model back to grafana/dashboard.json
```

Dashboard: `exam-<EXAM_TOKEN>`, uid `taskflow-b3`, URL `http://localhost:3001/d/taskflow-b3`.

Unless stated otherwise, the numbers below come from the recorded run: 20:32:30–20:37:33, before the fix. They were read from Prometheus with the same expressions over the run window. Panels that use `$__range` (B, D, E, G) show slightly different totals over the 20:32:00–20:38:30 screenshot range. For example, Panel G shows 207 and 16 instead of 205 and 16, and Panel D shows fewer runs per second, because the range is longer and `increase()` extrapolates at its edges.

### Exact PromQL

**A — Top 5 slowest endpoints by p95**
```promql
topk(5, histogram_quantile(0.95, sum by (le, method, route) (rate(http_request_duration_seconds_bucket{route!="unmatched"}[1m]))))
```

**B — Total request time consumed per endpoint (dashboard time range)**
```promql
sort_desc(sum by (method, route) (increase(http_request_duration_seconds_sum{route!="unmatched"}[$__range])))
```

**C — Average and p99 DB query duration by query_name**
```promql
sum by (query_name) (rate(db_query_duration_seconds_sum[1m])) / sum by (query_name) (rate(db_query_duration_seconds_count[1m]))
histogram_quantile(0.99, sum by (le, query_name) (rate(db_query_duration_seconds_bucket[1m])))
```

**D — Slowest query (p99) and how often it runs (table)**
```promql
histogram_quantile(0.99, sum by (le, query_name) (rate(db_query_duration_seconds_bucket[$__range]))) >= 0
sum by (query_name) (rate(db_query_duration_seconds_count[$__range])) > 0
sum by (query_name) (increase(db_query_duration_seconds_count[$__range])) > 0
```

**E — N+1 detector (median queries per request by route)**
```promql
sort_desc(histogram_quantile(0.5, sum by (le, route) (increase(db_queries_per_request_bucket{route!="unmatched"}[$__range]))) >= 0)
```

**F — Harmful queries: executions per second slower than 16 ms**
```promql
(sum by (query_name) (rate(db_query_duration_seconds_count[1m])) - sum by (query_name) (rate(db_query_duration_seconds_bucket{le="0.016"}[1m]))) > 0
```

**G — Rows returned per `notes_list` query (distribution, "Format: Heatmap" turns cumulative buckets into per-bucket counts)**
```promql
sum by (le) (increase(db_rows_returned_bucket{query_name="notes_list"}[$__range]))
```

**H — p95 latency and 5xx error rate by tenant**
```promql
histogram_quantile(0.95, sum by (le, tenant) (rate(http_request_duration_seconds_bucket{tenant!~"none|unknown"}[1m])))
(sum by (tenant) (rate(http_requests_total{tenant!~"none|unknown", status=~"5.."}[1m])) or sum by (tenant) (rate(http_requests_total{tenant!~"none|unknown"}[1m])) * 0) / sum by (tenant) (rate(http_requests_total{tenant!~"none|unknown"}[1m]))
```
The error rate counts 5xx only. The load test calls `/api/notes/1` for every tenant, so the 404s are correct tenant isolation, not failures. The `or … * 0` part keeps tenants with zero errors on the graph at 0%.

**I — Saturation: in-flight requests vs latency**
```promql
http_requests_in_flight
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route!~"unmatched|/healthz|/readyz"}[15s])))
sum(rate(http_request_duration_seconds_sum{route!~"unmatched|/healthz|/readyz"}[15s])) / sum(rate(http_request_duration_seconds_count{route!~"unmatched|/healthz|/readyz"}[15s]))
```
A short 15 s window is used so the latency line itself lags as little as possible.

### Panels A and B — which endpoint wins

| Endpoint | p95 over the run (A) | Requests | Avg per request | Total time (B) | Share of B |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET /api/notes | **19.78 s** | 221 | 7.58 s | **1,676.6 s** | 83.2% |
| GET /api/stats | 4.70 s | 205 | 1.30 s | 266.5 s | 13.2% |
| GET /api/search | 0.997 s | 205 | 0.265 s | 54.4 s | 2.7% |
| GET /api/notes/:id | 0.249 s | 205 | 0.083 s | 17.1 s | 0.8% |

On this data **GET /api/notes wins both panels**. It is the slowest per request (A) because of the N+1 over an unindexed collection, plus the heavy tenant's `limit=5000` calls. It also consumed the most total time (B).

They are different questions. A ranks how slow one call is. B is calls × average latency, which is where the server's time actually goes. The two rankings agree here only because the load script calls every endpoint equally often (205 times each), so B's order simply follows latency. With a realistic traffic mix they split. For example, `/api/notes/:id` averages 0.083 s, so at about 20,200 calls (98× its call count here) it would overtake `/api/notes` in B while still being the fastest endpoint in A. The same split does happen on the database side of this run. `stats_tag_count` has the worst p99 (4.09 s), but `tags_by_note` consumed 9.8× more total DB time (1,695 s vs 172.5 s) because it ran 25× more often (Panel D). **Fix the endpoint that wins B first: that is where the capacity goes.**

### Panel C

Healthy indexed lookups (`note_by_id`, `notes_list`) averaged **4.7 ms** in the baseline minute (p99 14–15 ms). The full scans averaged 65–218 ms (`notes_search` 65 ms, `tags_by_note` 111 ms, `stats_note_ids` 139 ms, `stats_tag_count` 218 ms). Over the whole run, the burst pushed p99 of every scan above 1.8 s. The gap between the solid (avg) and dashed (p99) lines is widest during the burst.

### Panel D — slowest single query and frequency

| query | p99 | runs per second | runs | total DB time |
| --- | ---: | ---: | ---: | ---: |
| **stats_tag_count** | **4.09 s** | 0.677 | 205 | 172.5 s |
| stats_note_ids | 3.26 s | 0.677 | 205 | 93.3 s |
| tags_by_note | 2.81 s | **17.39** | **5,269** | **1,695.2 s** |
| notes_search | 1.84 s | 0.677 | 205 | 53.7 s |
| notes_list | 0.254 s | 0.730 | 221 | 6.2 s |
| note_by_id | 0.128 s | 0.677 | 205 | 3.2 s |

- **Slowest query:** `stats_tag_count` (`tags.countDocuments({note_id: {$in: [...all of the tenant's note ids]}})` for `/api/stats`), p99 4.09 s.
- **Is it also the most frequent?** No. It ran 205 times (0.68/s). The most frequent is `tags_by_note`: 5,269 runs (17.4/s, 25× more), because the N+1 runs it 20 times per `/api/notes` page.
- **Evidence:** `tags_by_note` has a lower p99 (2.81 s) but used 1,695 s of DB time, 9.8× more than the slowest query. That made it the right target for Task 34.

### Panel E — N+1 detector

| route | median DB queries per request |
| --- | ---: |
| **/api/notes** | **21** (20.85 raw, shown as 21) |
| /api/stats | 2 |
| /api/notes/:id | 1 (1 when the note belongs to another tenant, 2 with tags) |
| /api/search | 1 |

`/api/notes?limit=20` makes 1 + 20 = 21 queries while every other endpoint makes 1 or 2. That is the N+1. The average for `/api/notes` was 24.3, higher than the median, because the `limit=5000` requests ran many more than 21 queries before they timed out.

### Panel F — threshold justification

**Threshold: 16 ms** (`le="0.016"`, a bucket boundary of `db_query_duration_seconds`).

Normal query time on this system comes from the indexed lookups, `note_by_id` and `notes_list` with a limit of 20:

| measurement | avg | p99 | share ≤ 16 ms |
| --- | ---: | ---: | ---: |
| baseline run, 20:13–20:16 (normal traffic only) | 1.4–1.5 ms | 4.0–5.7 ms | **100%** |
| baseline minute of the recorded run, Low Power Mode | 4.7 ms | 14.0–15.0 ms | **100%** |
| full-scan queries (`notes_search`, `tags_by_note`, `stats_*`), same baseline | 65–218 ms | 126–501 ms | **0%** |

16 ms is the smallest boundary that contains every healthy query in both baselines, about 3× their worst p99 in the first baseline. It sits below the fastest full scan (`notes_search` averaged 28 ms in the first baseline and 65 ms under Low Power Mode). A query slower than 16 ms is therefore abnormal here. It is either a full collection scan, or an indexed query stuck waiting for CPU. 100 ms would be the wrong choice: `tags_by_note` (48–111 ms average, run 17 times a second) would never count as harmful.

Observed harmful rate: 11.5 queries/s in the baseline minute (of 12.5 total), 19.4/s with the heavy tenant and 32.5/s in the burst. During the burst even indexed queries crossed 16 ms (44 `note_by_id`, 66 `notes_list` over the run).

### Panel G — rows returned and the maximum limit

`notes_list` over the run: **205 queries returned ≤ 20 rows, 16 returned 5,000 rows** (acme's `limit=5000`). None of those 16 requests reached the client. Each one fetched 5,000 notes, then ran tag lookups one at a time until the 15 s budget ran out (504). After the Task 34 index the same request succeeds: 200 in 1.7 s, 5,001 queries and a **1,159,059-byte** response. With 8 clients sending it at once, it slowed to about 7 s and pushed the route p95 to 10–11 s (Task 33 retest).

**Recommendation: maximum `limit` of 100, default 20.** Measured after the fix, `limit=100` takes 55 ms and returns 22.9 KB. That is 5× the default page and still cheap. `limit=5000` costs 50× the rows, 1.16 MB per response, and seconds of server time.

When a client asks for more, the API should reject it with **400 Bad Request** and a clear message such as `{"error": "limit must be between 1 and 100"}`. It should also offer pagination (`page`/cursor with a next link) to walk through more data. Silently clamping to 100 is the alternative. I prefer 400, because a clamped response can look like the complete result set to the client.

### Panel H — the worse tenant, and why

**Worse tenant: acme.** With the heavy tenant running, outside the burst (20:35:45–20:37:30):

| tenant | p95 | 5xx (504) |
| --- | ---: | ---: |
| **acme** | **14.63 s** | **7** |
| hooli | 3.70 s | 0 |
| initech | 3.43 s | 0 |
| globex | 2.96 s | 0 |
| umbrella | 2.80 s | 0 |

acme also has the most data: 30,000 notes vs 5,000 for every other tenant. Proof that **heavier requests** are the cause, not the data:

1. **Same data, normal requests → acme is not worse.** In the baseline minute (20:32:32–20:33:30) acme's data was identical but it sent only normal requests. Its p95 was 2.80 s, inside the other tenants' 2.40–2.90 s, with no errors. acme jumped to about 15 s at exactly t+60 s, when only the request type changed.
2. **Same route, different request.** Comparing identical requests in the heavy window, data size shows up only as a small effect on endpoints that read the whole tenant: `/api/search` 0.375 s vs 0.096–0.205 s, and `/api/stats` 1.75 s vs 0.48–1.08 s (2–3×, all under 2 s). On `/api/notes`, where acme sends `limit=5000`, it is 15.49 s vs 2.95–5.60 s.
3. **The errors are the heavy requests.** All 16 `limit=5000` requests returned 504 (load test output). `db_rows_returned` shows exactly 16 `notes_list` queries that returned 5,000 rows. acme's other 504s happened during the burst, when every tenant got them.
4. **After the index fix** (run 20:42–20:47) the pattern holds without errors: acme p95 1.81 s vs 0.087–0.089 s; `/api/notes` 1.87 s vs 0.042–0.049 s (limit=5000 vs limit=20); `/api/stats` 0.436 s vs 0.097–0.099 s (data effect again).

More data makes acme about 2–4× slower on search and stats. The heavy requests make its overall p95 4–5× worse before the fix (about 20× after it) and cause all of its errors outside the burst.

### Panel I — saturation timing

5-second samples around the burst (burst 20:34:45–20:35:15):

| time | in-flight | p95 [15s] | avg [15s] | tags_by_note avg | note_by_id avg | MongoDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20:34:45 | 2 | 2.99 s | 1.41 s | 128 ms | 5.6 ms | 207% |
| 20:34:55 | **23** | 2.87 s | 0.75 s | **232 ms** | **23.6 ms** | 553% |
| 20:35:05 | 44 | 5.75 s | 1.31 s | 939 ms | 27.7 ms | 848% |
| 20:35:15 | **54 (peak)** | 22.74 s | 4.91 s | 1,730 ms | 40.1 ms | 902% |
| 20:35:20 | 40 | **24.08 s (peak)** | 5.40 s | 1,852 ms | 43.7 ms | 981% |
| 20:35:30 | 18 | 15.97 s | **9.29 s (peak)** | 744 ms | 21.2 ms | 266%* |
| 20:35:40 | 2 | 15.33 s | 6.08 s | 194 ms | 8.9 ms | 306% |
| 20:35:50 | 2 | 3.00 s | 0.85 s | 141 ms | 4.3 ms | — |

*docker stats sample at 20:35:35.

- **Did latency rise at the same time as in-flight?** No. In-flight jumped within 10 s of the burst start. Per-query DB time rose **at the same scrape** (`note_by_id` 5.6 → 23.6 ms, `tags_by_note` 128 → 232 ms), and MongoDB CPU went from 207% to 553%. Request latency lagged. p95 was still 2.87 s at 20:34:55, reached only 5.75 s by 20:35:05, jumped to 15.1 s at 20:35:10, and peaked at 20:35:20, 5 s after in-flight peaked. The average peaked at 20:35:30, when in-flight had already fallen to 18. Latency stayed high until 20:35:40, 25 s after the burst ended.
- **Why the delay:** a request's duration is recorded only when it finishes. The requests admitted during the burst each had to run 21 table scans that had become 5–14× slower, so they finished 10–20 s later, many at the 15 s budget.
- **What it says about the bottleneck:** requests queued inside MongoDB, on CPU. It was not the app or the network. MongoDB used about 900–980% CPU (all 8 vCPUs), while Node's event-loop lag stayed at or below 0.16 s and app CPU at or below 120%. Node was waiting, not working. The recovery lag is MongoDB draining its queue. After the index fix, the same burst produced at most 2 in-flight requests and no latency spike. That confirms the full scans were the bottleneck.

---

## Task 33 — Grafana alert

Rule `grafana/provisioning/alerting/p95-latency.yml` (file-provisioned, survives restarts), folder "Taskflow B3", evaluated every 10 s:

```promql
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{route!~"unmatched|/healthz|/readyz"}[1m]))) >= 0
```

The condition is a threshold `> 5` per route, with `for: 1m`. No data counts as OK: an idle route has no latency, and `>= 0` drops its NaN.

- **Threshold: 5 s.** Normal p95 (Panel A, normal traffic only) was 1.39 s for the slowest route (`GET /api/notes`, the N+1) in the first baseline. It reached 2.95–2.99 s in baseline minutes under Low Power Mode, and no other route exceeded 0.9 s. My first threshold was 3 s (about 2× the first baseline). It was raised to 5 s before the recorded run because the throttled baseline came within 0.05 s of it. 5 s sits clearly above the worst normal p95, the heavy tenant drives the route to 13–15 s, and 5 is a histogram bucket boundary, so the estimate is accurate exactly where the alert decides.
- **for: 1m.** The p95 has to stay above 5 s on every evaluation for a full minute.

Observed state history (Grafana, recorded run):

| time | route | state |
| --- | --- | --- |
| 20:34:10 | /api/notes | Normal → Pending (heavy tenant running since 20:33:30) |
| 20:35:10 | /api/notes | **Pending → Alerting (Firing)**, exactly 1 minute later |
| 20:35:20 | /api/stats | Normal → Pending (30 s burst) |
| 20:36:20 | /api/stats | **Pending → Normal, never fired** |
| 20:38:40 | /api/notes | Alerting → Normal (NoData), load stopped |

After the Task 34 fix, the same load never reached Pending (`/api/notes` p95 1.77 s). Heavier load still fires it: 8 acme workers on `limit=5000` produced Pending at 20:49:10 and **Alerting at 20:50:10**.

- **What `for: 0s` would do:** the alert would fire on the first 10 s evaluation above the threshold. At 20:35:20 the 30 s burst would have paged for `/api/stats` and then resolved a minute later: a false alert. With little traffic, a single slow request can also move a 1-minute p95 above the threshold for one evaluation, so `for: 0s` flaps between firing and resolved.
- **Why a longer `for` helps:** a condition that must hold for every evaluation over a whole minute ignores spikes, short bursts, one-off slow requests and restarts, and pages only on sustained degradation. The recorded run shows this: the sustained `/api/notes` problem fired, and the transient `/api/stats` spike did not. The cost is detection delay (here 1 minute plus the 1-minute rate window), so `for` should stay short compared with how long users can tolerate the problem.

---

## Task 34 — Fix one problem: Problem 3, the missing index on `tags.note_id`

Chosen because it is the easiest to prove: one plan change (COLLSCAN → IXSCAN) shows up directly in the explain output, and `tags_by_note` is the most-run query and the largest user of DB time (Panel D). The N+1 loop was **not** changed, so Panel E still shows 21.

Fix (migration `seed/fix-idx-tags-note-id.js`, the equivalent of `CREATE INDEX idx_tags_note_id ON tags (note_id)`), deployed at **20:41:39**. The Grafana annotation "Task 34 deploy: created index idx_tags_note_id on tags.note_id" marks that moment:

```bash
docker compose exec -T mongodb sh -c \
  'cat > /tmp/fix.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/fix.js' \
  < seed/fix-idx-tags-note-id.js
# idx_tags_note_id ready in 260 ms
./scripts/grafana.sh annotate "Task 34 deploy: created index idx_tags_note_id on tags.note_id (fix for Problem 3)"
```

The full raw output of `seed/task34-measure.js` is in `evidence/b3-task34-before.txt` and `evidence/b3-task34-after.txt`. Both runs happened with no load and the same power state (battery, Low Power Mode). The plans below are trimmed to the relevant fields.

### Before (explain "executionStats")

```text
db.tags.find({ note_id: 1 }, { _id: 0, name: 1 }).explain("executionStats")
  nReturned: 3, executionTimeMillis: 67, totalKeysExamined: 0, totalDocsExamined: 150002
  PROJECTION_SIMPLE <- COLLSCAN  filter { note_id: { $eq: 1 } }  docsExamined: 150002
tags_by_note average over 200 runs: 53.61 ms

stats filter (acme, 30000 note ids): db.tags.find({ note_id: { $in: [...] } })
  nReturned: 90070, executionTimeMillis: 118, totalKeysExamined: 0, totalDocsExamined: 150002
  PROJECTION_SIMPLE <- COLLSCAN
stats_tag_count countDocuments average over 20 runs: 132.70 ms
```

### After

```text
db.tags.find({ note_id: 1 }, { _id: 0, name: 1 }).explain("executionStats")
  nReturned: 3, executionTimeMillis: 0, totalKeysExamined: 3, totalDocsExamined: 3
  PROJECTION_SIMPLE <- FETCH (docsExamined 3) <- IXSCAN idx_tags_note_id  indexBounds note_id: [1, 1]  keysExamined: 3
tags_by_note average over 200 runs: 0.50 ms

stats filter (acme, 30000 note ids)
  nReturned: 90070, executionTimeMillis: 90, totalKeysExamined: 101705, totalDocsExamined: 0
  PROJECTION_COVERED <- IXSCAN idx_tags_note_id  (30,000 point ranges)
stats_tag_count countDocuments average over 20 runs: 117.20 ms
```

A tag lookup went from reading 150,002 documents to reading 3 keys and 3 documents: **53.61 ms → 0.50 ms (107× faster)**. The `/api/stats` count gained less (132.7 → 117.2 ms, −12%). It still has to visit about 100,000 index keys, but it no longer reads documents.

The app still works after the fix (every endpoint returned its normal status). `limit=20` dropped from about 1.1 s to 45 ms, and `limit=5000` changed from **504 at 15.06 s** to **200 in 1.7 s**.

### Grafana before/after — same load test, same settings

Before = recorded run 20:32:30–20:37:33, after = 20:42:46–20:47:47. Annotation at 20:41:39.

| Panel / measure | Before | After |
| --- | ---: | ---: |
| C — `tags_by_note` avg, baseline minute | 110.5 ms | 1.47 ms |
| C — `tags_by_note` avg, whole run | 321.8 ms | 0.28 ms |
| F — harmful queries (>16 ms), baseline / heavy / burst | 11.5 / 19.4 / 32.5 per s | 1.44 / 2.31 / 8.23 per s |
| A — `GET /api/notes` p95, whole run | 19.78 s | 1.77 s |
| B — total time on `GET /api/notes` | 1,676.6 s | 240 s (with 164 instead of 16 heavy requests now completing) |
| H — acme p95 with heavy tenant | 14.63 s, 7 × 504 | 1.81 s, no errors |
| I — max in-flight requests | 54 | 2 |
| load test `/api/notes?limit=20` avg / p95 | 7.05 s / 16.35 s, 57 × 504 | 0.031 s / 0.065 s, 0 errors |
| load test `limit=5000` | 16 requests, all 504 | 164 requests, all 200, avg 1.44 s |
| Task 33 alert | Firing | never Pending |

In Panels C and F, the `tags_by_note` lines drop by two orders of magnitude at the annotation.

### What the fix cost

| cost | before | after |
| --- | ---: | ---: |
| index `idx_tags_note_id` size | — | **1,024,000 bytes (1.0 MB)**, 15% of the 6.7 MB tag data |
| total index size on `tags` | 1,867,776 bytes | 2,899,968 bytes (+55%) |
| `insertMany` 10,000 tags, median of 9 | 36 ms (0.004 ms/doc) | **56 ms (0.006 ms/doc), +56%** |
| 2,000 single `insertOne`, median of 9 | 462 ms (0.231 ms/doc) | 452 ms (0.226 ms/doc), no measurable change |
| index build | — | 260 ms |

Bulk writes became about 56% slower, because every insert now also updates the index. For single inserts the network round trip dominates, so the difference was within noise. That is a good trade here: tags are read about 17 times per second (and 2,741 per second after the fix, see below) and written only by `POST /api/notes`.

### What to fix next, and what to measure first

**Next: Problem 1, the N+1.** Combine it with the cheap Problem 4 cap (limit ≤ 100). The after-fix run shows why:
- `tags_by_note` ran **825,049 times in 5 minutes (2,741 per second)**, 99.9% of all queries and 88% of DB time (229 s of 261 s).
- Panel E still shows 21 queries per page and 5,001 for `limit=5000`.
- It is now cheap per query, but it multiplies with page size and round trips. The Node process, not MongoDB, became the limit when 8 clients asked for 5,000 rows.

Replace the loop with one `tags.find({ note_id: { $in: noteIds } })` and group the tags in the app, so every page costs 2 queries.

Before deciding, I would measure:
- **The real traffic mix.** `sum by (route) (rate(http_requests_total[1h]))` from production, not the synthetic equal mix. Panel B's winner depends on it.
- **Panels B and D after this fix.** Check which endpoint and query now hold the most total time. After the fix, `stats_note_ids` and `stats_tag_count` have the highest p99 (234 ms and 203 ms), and `notes_search` still reads all 50,000 notes on every call.
- **For the search problem specifically:** how often `/api/search` is called, its p95 per tenant, and whether users need substring matching. A text index only matches whole words, so it changes behavior and adds its own index size and write cost, which would be measured the same way as above.
