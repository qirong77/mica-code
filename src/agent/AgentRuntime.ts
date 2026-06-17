import mitt from "mitt";
import {
  OpenAIClient,
  type OpenAIClientOptions,
} from "../../packages/agent/OpenAIClient.js";
import type {
  AgentSnapshot,
  IAgent,
  AgentUsageRecord,
} from "../../packages/agent/IAgent.js";
import type { MicaUiConversationMessage } from "../../packages/mica-ui/types.js";
import type {
  EffortOption,
  ProviderDefinition,
} from "../store/index.js";
import { getConfig } from "../store/index.js";

export type AgentRuntimeStatus =
  | { type: "connecting" }
  | { type: "thinking" }
  | { type: "streaming" }
  | { type: "calling_tool"; toolNames?: string[] }
  | { type: "completed"; elapsedMs?: number }
  | { type: "error"; message: string };

export type AgentRuntimeEvents = {
  text: string;
  thinking: string;
  toolCall: { name: string; args: string; id?: string };
  toolResult: { name: string; result: string; id?: string };
  usage: AgentUsageRecord;
  status: AgentRuntimeStatus;
};

export type AgentRuntimeSnapshot = {
  providerId: string;
  model: string;
  effort: EffortOption;
  messages: AgentSnapshot<unknown, AgentUsageRecord>["messages"];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
};

type AgentRuntimeConfig = {
  provider: ProviderDefinition;
  model: string;
  effort: EffortOption;
};

export class AgentRuntime {
  readonly events = mitt<AgentRuntimeEvents>();
  private client: IAgent<OpenAIClientOptions> | null = null;
  private runId = 0;
  private currentConfig: AgentRuntimeConfig;

  constructor() {
    this.currentConfig = this.readConfig();
    this.recreateClient();
  }

  get config() {
    return this.currentConfig;
  }

  get currentRunId() {
    return this.runId;
  }

  get isConfigured() {
    return Boolean(this.currentConfig.provider.api_key);
  }

  reloadConfig(resetSession = true) {
    this.currentConfig = this.readConfig();
    this.recreateClient();
    if (resetSession) this.clearSession();
  }

  abort() {
    this.runId++;
    this.events.emit("status", { type: "error", message: "已中止当前 agent" });
  }

  clearSession() {
    this.runId++;
    this.client?.reset();
  }

  getSnapshot(): AgentRuntimeSnapshot {
    const snapshot = this.client?.getSnapshot();
    return {
      providerId: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false
        ? this.currentConfig.effort
        : "none",
      messages: snapshot?.messages ?? [],
      usageHistory: snapshot?.usageHistory ?? [],
      lastUsage: snapshot?.lastUsage,
    };
  }

  loadSnapshot(snapshot: AgentRuntimeSnapshot) {
    this.runId++;
    this.client?.loadSnapshot({
      model: snapshot.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: string): Promise<{ runId: number; text: string }> {
    const runId = ++this.runId;
    const startedAt = Date.now();

    if (!this.client || !this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      this.events.emit("status", { type: "error", message });
      throw new Error(message);
    }

    this.events.emit("status", { type: "connecting" });
    try {
      const text = await this.client.query(question);
      if (this.isCurrent(runId)) {
        this.events.emit("status", {
          type: "completed",
          elapsedMs: Date.now() - startedAt,
        });
      }
      return { runId, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrent(runId))
        this.events.emit("status", { type: "error", message });
      throw error;
    }
  }

  isCurrent(runId: number) {
    return runId === this.runId;
  }

  private recreateClient() {
    if (!this.currentConfig.provider.api_key) {
      this.client = null;
      return;
    }
    this.client = new OpenAIClient(this.clientOptions());
    this.client.onText = (text) => {
      this.events.emit("status", { type: "streaming" });
      this.events.emit("text", text);
    };
    this.client.onThinking = (thinking) => {
      this.events.emit("status", { type: "thinking" });
      this.events.emit("thinking", thinking);
    };
    this.client.onToolCall = (name, args, id) => {
      this.events.emit("status", { type: "calling_tool", toolNames: [name] });
      this.events.emit("toolCall", { name, args, id });
    };
    this.client.onToolResult = (name, result, id) => {
      this.events.emit("toolResult", { name, result, id });
    };
    this.client.onUsage = (usage) => {
      this.events.emit("usage", usage);
    };
  }

  private clientOptions(): OpenAIClientOptions {
    return {
      apiKey: this.currentConfig.provider.api_key,
      baseURL: this.currentConfig.provider.api_base,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false
        ? this.currentConfig.effort
        : "none",
    };
  }

  private readConfig(): AgentRuntimeConfig {
    const config = getConfig();
    const provider = config.providers.find((item) => item.id === config.provider);
    if (!provider) {
      throw new Error(`Provider not found: ${config.provider || "(empty)"}`);
    }
    return {
      provider,
      model: config.model,
      effort: config.effort,
    };
  }
}
