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
