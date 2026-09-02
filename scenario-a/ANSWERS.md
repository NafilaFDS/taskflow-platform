### Task 4 — Why dan can list the folder but not read the file?

Dan can list the `/srv/app/secrets/` directory because he has permission to access the directory itself, which allows him to see the filenames. However, he does not have read permission for `db-password.txt`, so attempting to read its contents results in “Permission denied”.

### Task 6 — The permission difference

Without sudo, I could see that port 8080 was listening, but I could not see
which process was using it. lsof also showed no process information.
With sudo, I could see the python3 process, its PID, and that it was owned
by root. This is because root has permission to inspect processes belonging
to other users.

### Task 7 — Decide and act

The process was started manually. I know this because the process command
was `python3 -m http.server 8080` and its parent process was the `sudo`
command that I manually ran in the terminal. It was not started by a
systemd service or cron.

If the process were started by systemd, using `kill -9` on its PID would
only kill the current process. systemd could start it again if the service
is configured to restart. The proper way would be to stop the systemd
service itself.

Since this process was started manually, I stopped it with `sudo kill
111152`. I then ran `sudo ss -lptn 'sport = :8080'` and got no output,
which confirms that port 8080 is now free.

### Task 8 — The remote access problem

A **connection timed out** means the connection attempt received no response, usually because a firewall is silently dropping the packets. A **connection refused** means the host was reachable but actively rejected the connection, typically because no application is listening on that port.

### Task 10-> Test 1 — Missing configuration file

I ran the healthcheck script with a configuration file path that does not exist:

`/tmp/definitely-does-not-exist.conf`

The script reported that the configuration file was missing or unreadable and exited with status code 2.

### Result

- Missing config was detected correctly.
- Exit code was `2`.

### Task 10-> Test 2 — Unresolvable URL

I created a test configuration containing:

`bad|http://doesnotexist.invalid/|200`

The script reported the service as FAIL with HTTP status `000`. It did not hang or crash because the curl request has a 3-second timeout.

### Result

- Unresolvable service was reported as `FAIL`.
- The script completed normally.
- Exit code was `1` because a service failed.

## Changes

I added configuration-file validation and curl timeout/error handling so that missing configuration files and unreachable services are handled safely.
