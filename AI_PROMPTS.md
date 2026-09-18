# AI Prompt Log

This file documents AI assistance used during the DevOps Practical Exam.

---

## Entry 1 — SSH and VPS Access

**Prompt:**

"How do I connect to an Ubuntu VPS from macOS using SSH, and how can I verify that I am connected as the correct user?"

**Result:**

Used SSH from macOS Terminal to connect to the assigned Ubuntu VPS. Verified the active user with `whoami` and server hostname with `hostname`.

---

## Entry 2 — Exam Evidence Token

**Prompt:**

"How should I create and persist an environment variable for an exam evidence token so it remains available in future shell sessions?"

**Result:**

Created the `EXAM_TOKEN` environment variable, verified it with `echo`, and added it to the shell configuration for persistence.

---

## Entry 3 — Linux User and Group Access

**Prompt:**

"Given four Linux users (alice, bob, carol, and dan) and the groups devs, ops, and auditors, what is the correct approach to create the users and assign their group memberships?"

**Result:**

Created the required users and groups and configured supplementary group memberships using Linux user management commands.

---

## Entry 4 — Permission Planning

**Prompt:**

"How can Linux ownership, groups, permissions, and ACLs be combined to implement different access levels for developers, operations users, and auditors?"

**Result:**

Used the explanation to plan the permission model before applying and testing the Task 1 access requirements.

# Prompts Used for A4 Tasks 12–15

## Task 12

- Help me understand the task requirements first and break them into the exact commands I need to run.
- Give me the safest commands to configure and test the required service without changing anything unrelated.
- Tell me what output I should expect so I can verify that the configuration worked correctly.
- Help me choose the minimum screenshots needed to prove that I completed the task.

## Task 13

- Explain how to configure the systemd service according to the task requirements.
- Give me the exact systemd unit/configuration files I should create and explain what each important option does.
- Show me how to start, stop, restart, and check the status of the service.
- How can I verify from journalctl that the service started correctly and that its logs are being recorded?
- Can I combine the required verification commands into one terminal screenshot while keeping the evidence clear?

## Task 14

- Help me test the service failure/crash behavior several times and verify how systemd handles the failures.
- Give me a command that triggers the application crash repeatedly so I can collect reliable evidence.
- How can I use journalctl to compare the current boot logs with logs from the previous boot?
- What evidence should I capture to prove that systemd restarted or recovered the service as required?
- Check whether this screenshot clearly proves the requirement and tell me if I need another one.

## Task 15

- Help me verify the final configuration without changing the working setup.
- Give me commands to confirm the environment/token and timestamp for the task evidence.
- Help me collect the final verification output in a concise way for my screenshot.
- Based on the task requirements and my terminal output, tell me exactly what should go into ANSWERS.md.
- Write a short explanation of what I configured, how I tested it, and what the results prove.

## B3 Tasks

You are working on my existing `taskflow-platform` project for DevOps exam Scenario B.

I need you to COMPLETELY implement B3 — Instrumentation, Prometheus and Grafana, Tasks 29–34.

IMPORTANT:

- First inspect the entire existing project structure, Docker Compose files, application code, database code/schema, existing deliberate problems, routes/endpoints, and previous B1/B2 implementation.
- Do NOT blindly create a new application or replace the existing architecture.
- Preserve the existing app behavior and existing deliberate problems until Task 34.
- Work incrementally and verify every step.
- Use the existing language/framework/database in the project.
- The exam token is available as environment variable EXAM_TOKEN. Never hardcode the token.
- Do not expose secrets unnecessarily.

## Phase 1 — Inspect

Before changing code, identify and report:

1. Application language/framework.
2. API entry point.
3. All relevant API routes.
4. Database technology and DB access layer.
5. Docker Compose services and ports.
6. The four deliberate performance problems.
7. Where request handling and database queries should be instrumented.
8. Existing Docker/network setup.

Then implement B3.

## Task 29 — Application metrics

Add the appropriate Prometheus client library for the existing language.

Expose:

GET /metrics

Implement these metrics with exactly the required purposes/labels:

1. http_requests_total
   Counter
   labels: route, method, status, tenant

2. http_request_duration_seconds
   Histogram
   labels: route, method, tenant

3. db_query_duration_seconds
   Histogram
   label: query_name

4. db_queries_per_request
   Histogram
   label: route

5. db_rows_returned
   Histogram
   label: query_name

6. http_requests_in_flight
   Gauge
   no labels

CRITICAL:
The route label MUST use route patterns, not concrete IDs.

For example:
GOOD: /api/notes/:id
BAD: /api/notes/48213

Avoid high-cardinality labels.

Instrument the actual application/database code so the metrics represent real requests and queries.

Make sure errors are also counted correctly.

Test:
curl localhost:3000/metrics

Also make sure normal API requests generate meaningful metrics.

## Task 30 — Prometheus

Add Prometheus to the existing Docker Compose setup.

Requirements:

- Prometheus container
- port 9090 exposed to host
- Prometheus config mounted into the container
- Prometheus scrapes the application /metrics endpoint
- correct Docker service/network hostname
- restart-safe configuration

Verify:
http://localhost:9090/targets

The application target MUST show UP.

Also run at least one PromQL query that returns real data.

## Task 31 — Load generation

Create a reusable load-testing script inside the project, preferably:

scenario-b/loadtest.sh

Requirements:

- minimum runtime: 5 minutes
- hit ALL relevant API endpoints, including:
  /api/notes?limit=20
  /api/search?q=abc
  /api/stats
  /api/notes/1
- use at least 3 tenants
- include a deliberate 30-second heavy-load burst in the middle
- deliberately make one tenant significantly worse
- use something like /api/notes?limit=5000 for the heavy tenant
- keep the script safe and easy to stop
- do not modify the deliberate performance problems yet

The script should produce useful traffic for Grafana.

Also provide a simple command to run it.

If using curl, avoid creating unnecessary terminal output.

## Task 32 — Grafana

Add Grafana to Docker Compose.

Requirements:

- Grafana port 3001
- default login admin/admin unless the existing project requires another safe configuration
- Prometheus configured as the data source
- create ONE dashboard
- dashboard name MUST be:

exam-${EXAM_TOKEN}

The dashboard must contain these 9 panels:

A. Top 5 slowest endpoints by p95 latency.

B. Endpoint consuming the most TOTAL request time.
This must be based on total accumulated request duration, not simply p95.

C. Average and p99 DB query duration by query_name.

D. Slowest single query and how frequently it runs.
Show p99 query duration and query frequency.

E. N+1 detector.
Show DB queries per request by route.
The /api/notes route with limit=20 should clearly show around 21 queries if that deliberate problem exists.

F. Harmful/slow DB queries over time.
Use histogram buckets and choose a threshold based on the actual observed query data, not an arbitrary round number.
Document why the threshold was selected.

G. DB rows returned distribution.
This must expose the limit=5000/unbounded-result problem.

H. Error rate and p95 latency by tenant.
The deliberately bad tenant should clearly stand out.

I. Saturation:
in-flight requests versus request latency.

Use correct PromQL for every panel.

Do NOT fake or hardcode dashboard data.

Make panels readable and give them useful titles/units.

Export the final dashboard JSON to:

scenario-b/grafana/dashboard.json

Also create or update:

ANSWERS.md

with the exact PromQL used for all nine panels.

For Panels A and B explicitly state which endpoint wins each metric on the actual generated data and explain why the results differ.

For Panel D state:

- slowest query
- whether it is also the most frequent
- evidence from the metrics

For Panel F:

- state the threshold selected
- show the observed normal query duration that justified it
- explain why the threshold represents abnormal behavior

For Panel G:

- recommend a maximum API limit based on the observed behavior
- explain what the API should do when a client exceeds it

For Panel H:

- identify the worse tenant
- prove whether the reason is heavier requests or more underlying data using the collected metrics

For Panel I:

- explain whether latency increased at the same time as in-flight requests or after a delay
- explain what that timing suggests about the bottleneck

## Task 33 — Grafana alert

Create a Grafana alert rule for p95 latency.

Requirements:

- alert when p95 latency for any route stays above a chosen threshold
- threshold must be based on the normal p95 observed in Panel A
- choose a sensible sustained `for` duration
- make the alert actually enter FIRING state using heavy load
- do not permanently leave unnecessary heavy load running

Document in ANSWERS.md:

- threshold
- why threshold was chosen
- for duration
- what for: 0s would do
- why a longer duration reduces transient/false alerts

## Task 34 — Fix ONE deliberate problem

Choose one of the existing four deliberate problems.

Prefer the easiest problem to prove clearly with EXPLAIN ANALYZE and Grafana.

Before modifying it:

1. Capture/record the relevant EXPLAIN ANALYZE output.
2. Record the relevant Grafana metric behavior.
3. Then implement the fix.
4. Verify the application still works.
5. Run EXPLAIN ANALYZE again.
6. Run load again and show the improvement in metrics.
7. Add a Grafana annotation marking the deployment/fix moment if possible.
8. Measure the cost of the fix.

If fixing the missing index, for example, measure:
SELECT pg_size_pretty(pg_relation_size('idx_tags_note_id'));

If appropriate, also measure INSERT timing before/after.

If fixing N+1, use a set-based query such as:
SELECT \* FROM tags WHERE note_id = ANY($1)

but adapt it to the actual existing schema/code rather than blindly copying it.

In ANSWERS.md document:

- which problem was fixed
- before EXPLAIN ANALYZE
- after EXPLAIN ANALYZE
- Grafana before/after observation
- cost/tradeoff of the fix
- which problem should be fixed next
- what metric/measurement should be collected before deciding

## Documentation

Create/update:

scenario-b/ANSWERS.md

Keep it simple and exam-friendly.

Include:

- Task 29 implementation summary
- Task 30 verification
- Task 31 load command and output
- exact PromQL for Panels A–I
- Panel A/B explanation
- Panel D answer
- Panel F threshold justification
- Panel G limit recommendation
- Panel H tenant analysis
- Panel I saturation analysis
- Task 33 alert explanation
- Task 34 before/after evidence and tradeoff

Do NOT invent numerical results.
Where real values are required, run the application/load test and use actual observed values.

## Screenshot/evidence preparation

Create a clear evidence checklist in:

scenario-b/EVIDENCE.md

List exactly what screenshots I need for Tasks 29–34.

Remember:
Before EVERY required screenshot for Tasks 29, 30, 31, 33 and 34, I must run:

echo "$EXAM_TOKEN | $(date)"

The dashboard name must include the exam token so the token is visible in Grafana screenshots.

Try to minimize the number of screenshots while still satisfying the exam requirements.

## Important working rules

- First inspect, then implement.
- Do not remove deliberate problems before Task 34.
- Do not fabricate metrics.
- Do not fabricate PromQL results.
- Do not fabricate EXPLAIN ANALYZE output.
- Do not fabricate load-test output.
- Test everything locally.
- Fix configuration/networking issues you encounter.
- Keep changes focused on B3.
- At the end, give me:
  1. files changed/created
  2. commands to start the stack
  3. command to run the load test
  4. URLs I need to open
  5. exact screenshot checklist
  6. any manual Grafana steps I still need to perform
  7. any issues that require my confirmation

Do not stop after creating files. Actually run and verify the stack as far as possible.

## B4 Tasks

You are my DevOps exam implementation agent.

We are now working on B4 — Docker Swarm: Scaling and Rollback (Tasks 35–40).

IMPORTANT:

- Do not blindly create a new application.
- First inspect the existing project and understand the current B3 implementation.
- Reuse the existing notes API/app wherever possible.
- Do not destroy or overwrite working B3 functionality.
- Keep the implementation simple and exam-friendly.
- The goal is to satisfy the B4 rubric, not to over-engineer.
- I am a beginner, so explain important changes briefly in simple language.
- Before making changes, inspect the repository structure, Dockerfile, docker-compose files, app entrypoint, healthcheck, and existing documentation.
- Do not commit or push anything unless I explicitly ask you to.

ENVIRONMENT:

- B4 can use a single Swarm node.
- Prefer a single Linux VM/VPS unless the existing environment already provides another node.
- I will use VS Code and its terminal, preferably through SSH into the VM/VPS.
- Do not create multiple VMs unless there is a concrete reason.
- Docker Hub/GHCR may be used as the image registry.

B4 REQUIREMENTS:

TASK 35 — Deploy the stack

- Initialize Docker Swarm if not already initialized.
- Verify with:
  docker node ls
- Prepare a Swarm stack for the notes API.
- Use a registry image that Swarm can pull.
- Deploy the stack.
- Service should be named notes_app if possible so the rubric commands work.
- Make sure replicas are running.
- We need evidence for:
  docker stack services notes
  docker node ls
- Clearly document whether this is a single-node or multi-node setup.

TASK 36 — Scale to 5 replicas

- Scale:
  docker service scale notes_app=5
- Verify:
  docker service ps notes_app
- Modify the app so the response contains:
  X-Served-By: <container hostname>
- Use the app's hostname/container ID to identify which replica served the request.
- Make sure /healthz works.
- Test all 5 replicas using repeated curl requests.
- If keep-alive causes the same container to appear repeatedly, use:
  curl -H "Connection: close"
- We need screenshot evidence showing all 5 different hostnames.

TASK 37 — Rolling update with zero downtime

- Ensure the Swarm service configuration supports:
  update order: start-first
- Ensure there is a useful healthcheck for /healthz.
- Create v2 with a clearly visible version difference from v1.
- Push v2 to the registry.
- Update the service from v1 to v2.
- During the update, continuously call /healthz and log HTTP status codes.
- Inspect:
  docker service ps notes_app
- Count failures honestly.
- Do NOT fake or hide failures.
- If zero failures are achieved, preserve the actual evidence.
- If failures occur, document the real reason.
- Make sure the app has graceful shutdown handling if appropriate.

TASK 38 — Broken v3 and rollback

- Create a deliberately broken v3.
- Prefer a simple predictable failure that Swarm can detect through the healthcheck or startup failure.
- Deploy v3:
  docker service update --image <registry>/notes-api:v3 notes_app
- Configure Swarm so failed updates automatically roll back.
- Monitor:
  docker service ps notes_app --no-trunc
  docker service inspect notes_app --format '{{json .UpdateStatus}}' | jq
- Verify the service returns to v2 after rollback.
- Capture timestamps so rollback duration can be calculated.
- Ensure UpdateStatus eventually shows rollback_completed if the rubric expects it.
- We need evidence of failed/rejected tasks, the final v2 state, and rollback_completed.
- Document what would happen without a healthcheck.

TASK 39 — Resource limits vs reservations

- Inspect the existing service resource configuration.
- Configure a memory reservation that the test node cannot satisfy, e.g. 8G on a 2GB node, only if this is safe and appropriate for the exam environment.
- Do NOT accidentally crash or damage the host.
- Scale the service so Swarm attempts to place more tasks.
- Show:
  docker service ps notes_app --no-trunc
- The output should demonstrate that the task cannot be scheduled because of insufficient resources.
- Document clearly:
  reservation = resource Swarm requires before scheduling
  limit = maximum resource the container is allowed to consume

TASK 40 — Scale down during live traffic

- Have the traffic loop running.
- Scale the service from 5 replicas to 2.
- Count HTTP failures from the traffic loop.
- Do not fabricate a zero-failure result.
- Preserve the real output for the exam evidence.

SCREENSHOT / EVIDENCE REQUIREMENTS:
For EVERY screenshot related to Tasks 35–40, the exam requires this to be run in the same terminal immediately before the screenshot:

echo "$EXAM_TOKEN | $(date)"

IMPORTANT:

- Do not forget this.
- The screenshot must show the token/date line and the relevant command/output in the same terminal when practical.
- Tell me exactly when I should take each screenshot.
- Minimize screenshots. Prefer one strong screenshot per required evidence item if it can clearly show everything.
- Do not take unnecessary screenshots.
- Tell me which screenshots are mandatory according to the rubric and which are optional.
- Keep screenshot filenames organized, e.g.:
  B4-T35-stack-services.png
  B4-T35-node-ls.png
  B4-T36-five-replicas.png
  etc.

ANSWERS.md:

- Inspect the existing ANSWERS.md before editing.
- Add a B4 section for Tasks 35–40.
- Use simple human-written explanations.
- Do not claim results that were not actually observed.
- Include:
  - single-node vs multi-node
  - commands/results
  - scaling evidence
  - rolling update result
  - failure count
  - rollback duration
  - healthcheck explanation
  - reservation vs limit explanation
  - scale-down traffic failure count
- Keep answers concise and exam-friendly.

WORKFLOW:

1. Inspect the existing project first.
2. Report what currently exists.
3. Identify what B4 already satisfies.
4. Identify what needs to be changed.
5. Implement only the necessary changes.
6. Build/test locally where appropriate.
7. Prepare registry images.
8. Configure Swarm.
9. Execute Tasks 35–40 one at a time.
10. After each task, stop and tell me:

- what happened
- whether the task passed
- exact screenshot command
- exact screenshot to take
- what to write in ANSWERS.md

11. Do not move to the next task until I confirm, unless I explicitly ask you to execute the whole sequence.
12. Never fabricate evidence.
13. Never delete useful existing B3 files without explaining why.

FIRST ACTION:
Do NOT start implementing yet.

First inspect the repository and give me:

1. Current project structure
2. Existing Docker setup
3. Existing /healthz endpoint and healthcheck
4. Existing Docker image/tag
5. Existing docker-compose/stack configuration
6. Whether v1 is ready for Swarm
7. What needs to be changed for B4
8. Whether one VM/VPS is sufficient
9. Exact files you intend to modify

Then wait for my confirmation before making changes.
