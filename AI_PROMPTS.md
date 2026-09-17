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
