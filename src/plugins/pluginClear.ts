import { micaUI } from "../../packages/mica-ui/index.js";
import type { AgentRuntime } from "../agent/AgentRuntime.js";
import type { SessionController } from "../session/SessionController.js";
import { clearUI, showMessage } from "../bootstrap.js";

export function registerClearPlugin(
  agent: AgentRuntime,
  sessionController: SessionController,
) {
  return {
    name: "clear",
    description: "清空当前对话和运行状态",
    action: () => {
      clearUI(agent, sessionController);
      showMessage("Session cleared");
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
