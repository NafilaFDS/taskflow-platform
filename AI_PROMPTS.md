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
