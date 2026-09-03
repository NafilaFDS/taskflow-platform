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
