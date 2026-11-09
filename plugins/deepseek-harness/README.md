# DeepSeek Harness

This official plugin starts the DeepSeek Harness CLI as an independent local Web
service. It runs the official `dsh web --no-open --host 127.0.0.1 --port <port>`
command; the same process provides the Harness frontend and backend.

The plugin does not start the DeepSeek Electron app and does not embed the Web
page in Mica. The generated address, including its access token, is shown in the
plugin settings as a clickable link.

The process is shared across Mica app-server sessions through a lock in
`plugin-data/deepseek-harness/`. A detached watchdog owns the CLI process and
exits when its app-server parent exits. Disabling the plugin or disposing the
session stops only a process started by that supervisor, even when another host
holds the shared guard. Lock cleanup is best-effort in that case; another host
can reclaim the stopped process's record without removing a replacement lock.
Changing the executable or port replaces the shared service with the new
configuration.

The watchdog uses `node` from `PATH`, like Mica's other Node helpers, never the
host's `process.execPath` (which is the Mica binary in an installed build).
Install Node.js if it is unavailable, or set `MICA_DEEPSEEK_NODE` to the Node
executable before starting Mica. The supervisor reports launch failures in the
plugin status and health report, including missing executables and missing PIDs.
After repair, the supervisor clears only its own previous health issue, and only
after the current live watchdog reports the service address as ready. A spawned
PID or a stale ready report from another watchdog is not enough; unrelated hook
and runtime errors remain visible.

The five-second supervision check does not launch a new process on every failure.
Failed launches and unexpected watchdog exits retry after 10, 20, 40, 80, 160,
then at most 300 seconds. This derived retry state is shared in `retry.json` under
the same process guard as the service lock, so another session cannot bypass the
delay. A minute of stable operation, a settings change, or an observed
disable/enable cycle resets the backoff. Abandoned startup reservations expire
after 30 seconds; live watchdogs with matching settings are left alone.

Supervisor tests use mock child processes and isolated temporary data directories;
they do not start DeepSeek Harness or change an existing service.
