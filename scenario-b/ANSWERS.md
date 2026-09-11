# Scenario B — Answers

## Task 22 — Make it smaller

I wrote a naive single-stage Dockerfile (`app/Dockerfile.naive`) and built it
alongside the existing multi-stage `app/Dockerfile`:

```
docker build -f Dockerfile.naive -t myapp:v1-naive .
docker build -f Dockerfile        -t myapp:v1       .
docker images myapp
```

### Measured sizes

| Image | Build | Size | Content size |
|---|---|---|---|
| `myapp:v1-naive` | single-stage | **1.7 GB** | 419 MB |
| `myapp:v1` | multi-stage | **245 MB** | 60.4 MB |

**Reduction: 85.6 %** (`(1703 − 245) / 1703`), well past the 60 % target.

### What the multi-stage build removes

The build stage is discarded — only `node_modules`, `package.json` and
`app.js` are copied into a fresh runtime stage. So the final image drops:

* **The Debian base image.** Runtime uses `node:22-alpine` instead of
  `node:22`. Biggest single saving.
* **The build toolchain.** `gcc`, `python3`, `git`, `curl`, `vim` are all
  in the naive image (`/usr/lib/gcc` alone is 102 MB); none are in `myapp:v1`.
* **Build caches.** The apt layer (48 MB) and npm cache `/root/.npm` (3.9 MB).
* **Unneeded context files.** Runtime copies three named paths, not `COPY . .`.

Layers are additive, so deleting these in a later `RUN` would not have
helped — the earlier layer still holds them. A second stage is the only
way to leave them behind.

### What I gave up

* **No debugging tools.** No `curl`, `vim`, `git`, only BusyBox shell. The
  healthcheck has to use `node -e` because `curl` does not exist.
* **No compiler at runtime.** Native modules can't be rebuilt in the container.
* **musl libc instead of glibc.** Some npm packages ship glibc-only binaries;
  musl also differs in DNS and locale handling. Main correctness risk.
* **Non-root user.** Safer, but can't `apk add` at runtime or bind ports < 1024.
* **More fragile Dockerfile.** A new runtime file must be added to the second
  stage by hand or it is silently missing at run time.

Note: the build stage also runs `npm prune --omit=dev`, but `package.json`
currently has no devDependencies, so that step saves nothing today. Almost
all the reduction comes from the smaller base image and the discarded toolchain.

### Verification

Both images were started and probed on `/healthz`:

| Image | Response | User | Healthcheck |
|---|---|---|---|
| `myapp:v1` | `{"status":"ok",...}` | `node` | healthy |
| `myapp:v1-naive` | `{"status":"ok",...}` | `root` | healthy |

The 85.6 % reduction costs no functionality — both serve the same endpoints.
