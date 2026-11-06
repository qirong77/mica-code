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
session stops only a process started by that supervisor.
