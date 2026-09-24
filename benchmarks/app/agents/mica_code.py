"""Harbor agent adapter for Mica Code.

Runs Mica Code as an installed agent inside a Harbor / Terminal-Bench task
container, so it can be scored head-to-head against other coding agents
(``--agent codex``, ``--agent claude-code``, ...) on the same model.

Two install modes:

``release`` (default)
    Download the published archive from GitHub Releases and run the bundled
    ``install.sh`` checker/installer.

``tarball``
    Upload a locally built archive (``--agent-kwarg tarball=/path/to.tar.gz``).
    Use this to benchmark unreleased builds; the archive must contain the
    ``mica`` binary at its root.

Credentials are supplied through Harbor's ``--agent-env``. Mica synthesizes a
runtime-only provider from ``OPENAI_API_KEY`` / ``OPENAI_BASE_URL`` when the
on-disk config carries no api_key, so no config file needs to be written here.

Example::

    harbor run -d terminal-bench/terminal-bench@2.1 \\
      --agent benchmarks.app.agents.mica_code:MicaCode \\
      --model openai/gpt-5.5 \\
      --agent-env OPENAI_API_KEY=sk-... \\
      --agent-env OPENAI_BASE_URL=https://api.openai.com/v1 \\
      --allow-agent-host api.openai.com
"""

from __future__ import annotations

import json
import shlex
import uuid
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal, override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

_OUTPUT_FILENAME = "mica.txt"

# Agent-private Mica home. Lives under the mounted logs directory so that
# session snapshots (and their usage history) are available on the host after
# the run, without another round trip into the container.
_MICA_HOME = EnvironmentPaths.agent_dir / "mica-home"

# Binaries land in ~/.local/lib/mica, launcher in ~/.local/bin (same layout as
# scripts/install.sh) so both install modes produce an identical command.
# Kept as shell-expandable strings (not PurePosixPath): a tilde inside double
# quotes does not expand, and these are always interpolated into shell text.
_REMOTE_PACKAGE_DIR = "$HOME/.local/lib/mica"
_REMOTE_BIN_DIR = "$HOME/.local/bin"
_REMOTE_UPLOAD_PATH = PurePosixPath("/tmp/mica-agent-upload.tar.gz")

_DEFAULT_REPO = "qirong77/mica-code"

# mica exec already speaks the `codex exec` CLI contract, so these flags are
# passed through verbatim rather than mapped. Headless never prompts for
# approval, but passing the flag explicitly keeps the intent auditable.
_HEADLESS_FLAGS = "--json --skip-git-repo-check --dangerously-skip-permissions"


class MicaCodeOptions(InstalledAgentOptions):
    tarball: str | None = Field(
        default=None,
        description=(
            "Local path to a mica archive containing the 'mica' binary at its "
            "root. When set, it is uploaded and installed instead of downloading "
            "a published release."
        ),
    )
    repo: str | None = Field(
        default=None,
        description=(
            "GitHub 'owner/name' used to download release archives. "
            f"Defaults to {_DEFAULT_REPO}."
        ),
    )
    provider: str | None = Field(
        default=None,
        description=(
            "mica provider id to use for the run. Harbor hands agents a "
            "qualified 'provider/model' string, but mica's provider ids are "
            "its own; the prefix is stripped and this value is used instead. "
            "Defaults to 'openai', which matches the runtime provider mica "
            "synthesizes from OPENAI_API_KEY / OPENAI_BASE_URL."
        ),
    )
    reasoning_effort: Annotated[
        Literal["none", "low", "medium", "high", "xhigh"] | None,
        Cli("-c", format="-c model_reasoning_effort={value}"),
    ] = Field(
        default=None,
        description="Model reasoning effort, mapped onto mica's --variant.",
    )
    thinking: Annotated[
        bool | None,
        Cli("--thinking"),
    ] = Field(
        default=None,
        description="Emit reasoning summary items inline in the exec JSON stream.",
    )
    max_turns: Annotated[
        int | None,
        Cli("--max-turns"),
    ] = Field(
        default=None,
        description="Cap on agent iterations for a single exec turn.",
    )


class MicaCode(BaseInstalledAgent):
    """Mica Code CLI agent (https://github.com/qirong77/mica-code)."""

    capabilities = AgentCapabilities()
    options_model = MicaCodeOptions

    @staticmethod
    @override
    def name() -> str:
        return "mica-code"

    @override
    def get_version_command(self) -> str | None:
        return f"{self._path_setup()}mica --version"

    @override
    def parse_version(self, stdout: str) -> str:
        lines = [line.strip() for line in stdout.splitlines() if line.strip()]
        if not lines:
            return ""
        return lines[-1].split()[-1]

    # ---------------------------------------------------------------- install

    @staticmethod
    def _path_setup() -> str:
        return f'export PATH="{_REMOTE_BIN_DIR}:$PATH"; '

    async def install(self, environment: BaseEnvironment) -> None:
        # curl/tar are needed by the release installer; the tarball path needs
        # tar only. Install them without assuming a particular base image.
        await self.exec_as_root(
            environment,
            command="""
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl tar
elif command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl tar
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl tar
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl tar
fi
""".strip(),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        if self._tarball:
            await self._install_from_tarball(environment)
        else:
            await self._install_from_release(environment)

        await self.exec_as_agent(
            environment,
            command=f"{self._path_setup()}mica --version",
        )

    async def _install_from_tarball(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(
            str(Path(self._tarball).expanduser().resolve()),
            _REMOTE_UPLOAD_PATH.as_posix(),
        )
        # Accept either a single-arch archive holding ``mica`` at its root, or a
        # multi-arch archive holding ``mica-linux-{x64,arm64}``. The task image
        # architecture is only knowable inside the container, so pick there.
        await self.exec_as_agent(
            environment,
            command=f"""
set -euo pipefail
pkg={_REMOTE_PACKAGE_DIR}
bin={_REMOTE_BIN_DIR}

rm -rf "$pkg"
mkdir -p "$pkg" "$bin"
tar -xzf {_REMOTE_UPLOAD_PATH} -C "$pkg"

cd "$pkg"
if [ ! -f mica ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
  if [ ! -f "mica-linux-$arch" ]; then
    echo "archive has no binary for linux-$arch" >&2
    exit 1
  fi
  mv "mica-linux-$arch" mica
fi
chmod 755 "$pkg/mica"

# node-pty's spawn-helper needs the executable bit; absent in the PTY-less
# archives we build for benchmarking, hence the ignore.
find "$pkg/node_modules" -name spawn-helper -exec chmod 755 {{}} + 2>/dev/null || true

printf '#!/bin/sh\\nexec %s/mica "$@"\\n' "$pkg" > "$bin/mica"
chmod 755 "$bin/mica"
rm -f {_REMOTE_UPLOAD_PATH}
""".strip(),
        )

    async def _install_from_release(self, environment: BaseEnvironment) -> None:
        repo = self._repo or _DEFAULT_REPO
        tag = self._version or "latest"
        if tag == "latest":
            url = f"https://github.com/{repo}/releases/latest/download/install.sh"
        else:
            url = f"https://github.com/{repo}/releases/download/{tag}/install.sh"

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL {shlex.quote(url)} | "
                f"MICA_GITHUB_REPO={shlex.quote(repo)} sh"
            ),
            env={"MICA_GITHUB_REPO": repo},
        )

    # -------------------------------------------------------------------- run

    def _resolve_model(self) -> str | None:
        """Map Harbor's model name onto mica's ``provider/model`` form."""
        if not self.model_name:
            return None
        # Harbor passes the qualified ``provider/model`` string it was given.
        # mica has its own provider ids (its built-in defaults include e.g.
        # ``deepseek`` with no credentials), so passing the prefix through
        # would select the wrong provider. Keep only the bare model and pair it
        # with the provider that actually holds the credentials.
        bare = self.model_name.split("/", 1)[-1]
        return f"{self._provider}/{bare}"

    def _runtime_env(self) -> dict[str, str]:
        env = {
            "MICA_HOME": _MICA_HOME.as_posix(),
            "NO_COLOR": "1",
            # Keep the run hermetic: no auto-update chatter, no telemetry.
            "MICA_DISABLE_TELEMETRY": "1",
        }
        return env

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._runtime_env()

        cli_flags = self.compile_cli_flags()
        flags = [cli_flags] if cli_flags else []

        model = self._resolve_model()
        if model:
            flags.append(f"--model {shlex.quote(model)}")

        # The instruction travels through an env var rather than argv so that
        # arbitrarily long or quote-heavy prompts survive intact.
        instruction_var = f"harbor_mica_instruction_{uuid.uuid4().hex}"
        run_env = {**env, instruction_var.upper(): instruction}

        # Executed through ``environment.exec`` rather than ``exec_as_agent``:
        # a task the agent fails to solve is a legitimate trial outcome, not an
        # infrastructure error, so a non-zero exit must not raise. The stream is
        # captured in-process instead of being tee'd into the logs mount, which
        # keeps usage parsing working even when that mount is not writable.
        result = await environment.exec(
            command=(
                f"{self._path_setup()}"
                f'{instruction_var}="${instruction_var.upper()}"; '
                f"unset {instruction_var.upper()}; "
                f"mica exec {_HEADLESS_FLAGS} "
                + " ".join(part for part in flags if part)
                + f' -- "${instruction_var}" </dev/null 2>&1'
            ),
            env=run_env,
        )

        self._write_output(result.stdout or "", result.stderr or "")

        if result.return_code != 0:
            self.logger.warning(
                "mica exec exited with code %s", result.return_code
            )

    # ---------------------------------------------------------------- usage

    def _read_output(self) -> str | None:
        path = self.logs_dir / _OUTPUT_FILENAME
        if not path.is_file():
            self.logger.debug("No mica exec output found at %s", path)
            return None
        try:
            return path.read_text(errors="replace")
        except OSError as exc:
            self.logger.debug("Failed to read %s: %s", path, exc)
            return None

    def _write_output(self, stdout: str, stderr: str) -> None:
        """Persist the raw exec stream on the host for usage parsing/debugging."""
        path = self.logs_dir / _OUTPUT_FILENAME
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            body = stdout + (f"\n--- stderr ---\n{stderr}" if stderr else "")
            path.write_text(body)
        except OSError as exc:
            self.logger.debug("Failed to write %s: %s", path, exc)

    @staticmethod
    def parse_usage(output: str) -> tuple[int, int, int] | None:
        """Sum ``turn.completed`` usage from mica's Codex-exec JSONL stream.

        Returns ``(input_tokens, cached_input_tokens, output_tokens)`` where
        ``input_tokens`` includes the cached portion, matching Harbor's
        ``n_input_tokens`` contract. Returns ``None`` when the stream carries no
        completed turn.
        """
        input_total = cached_total = output_total = 0
        found = False

        for line in output.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                # mica also writes human-readable lines (warnings, notices).
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or event.get("type") != "turn.completed":
                continue
            usage = event.get("usage")
            if not isinstance(usage, dict):
                continue
            found = True
            cached = max(0, int(usage.get("cached_input_tokens") or 0))
            cached_total += cached
            # mica reports input_tokens *excluding* the cached portion.
            input_total += max(0, int(usage.get("input_tokens") or 0)) + cached
            output_total += max(0, int(usage.get("output_tokens") or 0))

        if not found:
            return None
        return input_total, cached_total, output_total

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output = self._read_output()
        if output is None:
            return
        usage = self.parse_usage(output)
        if usage is None:
            self.logger.debug("No turn.completed usage found in mica output")
            return
        input_tokens, cached_tokens, output_tokens = usage
        context.n_input_tokens = input_tokens
        context.n_cache_tokens = cached_tokens
        context.n_output_tokens = output_tokens

    # ------------------------------------------------------------- accessors

    @property
    def _tarball(self) -> str | None:
        options = self.options
        if isinstance(options, MicaCodeOptions):
            return options.tarball
        return None

    @property
    def _repo(self) -> str | None:
        options = self.options
        if isinstance(options, MicaCodeOptions):
            return options.repo
        return None

    @property
    def _provider(self) -> str:
        options = self.options
        if isinstance(options, MicaCodeOptions) and options.provider:
            return options.provider
        return "openai"

    @property
    def mica_home_path(self) -> PurePosixPath:
        """Remote ``MICA_HOME`` (exposed for tests and tooling)."""
        return _MICA_HOME
