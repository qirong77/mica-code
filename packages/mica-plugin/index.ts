import { Plugin } from './Plugin.js';
import { PluginManager } from './PluginManager.js';
import { HookRegistry } from './HookRegistry.js';
import { ServiceContainer } from './ServiceContainer.js';
import { createServiceToken } from './ServiceToken.js';
import { inspectPlugins, loadFilePlugins } from './FilePluginLoader.js';
import { loadUserPlugins } from './UserPlugins.js';
import { writePluginStatus } from './PluginStatus.js';
import { parsePluginManifest, PLUGIN_API_VERSION, PLUGIN_MANIFEST_FILE } from './PluginManifest.js';
import {
  PLUGIN_SETTINGS_DIR,
  createPluginSettingsStore,
  normalizePluginSettingValues,
  readPluginSettings,
  resolvePluginSettingsPath,
  writePluginSettings,
} from './PluginSettings.js';
import { createPluginLogger, pluginLogDir, pluginLogPath } from './PluginLog.js';
import {
  describePluginLlm,
  isPluginLlmConfigured,
  pluginLlmSettingFields,
  resolvePluginLlmConfig,
} from './PluginLlm.js';
import {
  PLUGIN_HEALTH_DIR,
  clearPluginHealth,
  createPluginHealthStore,
  readPluginHealth,
  resolvePluginHealthPath,
  writePluginHealth,
} from './PluginHealth.js';
import { PluginPromptSections } from './PluginPrompt.js';
import {
  PluginPanelRegistry,
  normalizePluginPanelAction,
  normalizePluginPanelActionResult,
  normalizePluginPanelView,
} from './PluginPanel.js';
import {
  PluginSessionMenuRegistry,
  normalizePluginSessionMenuInput,
  normalizePluginSessionMenuResult,
} from './PluginSessionMenu.js';
import { PluginSettingsValidationError, validatePluginSettingValues } from './PluginSettings.js';
import { PluginActionRegistry } from './PluginActions.js';
import { MAX_PLUGIN_STATE_BYTES, normalizePluginStateRecord, validatePluginStateValue } from './PluginSessionState.js';
import {
  PLUGIN_DATA_DIR,
  SESSION_ANNOTATIONS_FILE,
  SESSION_ANNOTATIONS_VERSION,
  annotationCounts,
  annotationsOf,
  emptySessionAnnotations,
  normalizeSessionAnnotations,
  pluginDataDir,
  readAllSessionAnnotations,
  readSessionAnnotations,
  resolveAnnotationOptions,
  sessionAnnotationsExists,
  sessionAnnotationsPath,
  setSessionAnnotations,
  toggleSessionAnnotation,
  writeSessionAnnotations,
} from './sessionAnnotations.js';
import {
  PLUGIN_STATE_FILE,
  readDisabledPluginIds,
  readPluginState,
  setPluginDisabled,
  writePluginState,
} from './PluginState.js';
import {
  PLUGIN_SKILLS_DIR,
  publishPluginSkills,
  readPublishedPluginSkills,
  resolvePluginSkillsDir,
} from './PluginSkills.js';

export const micaPlugin = {
  Plugin,
  PLUGIN_DATA_DIR,
  SESSION_ANNOTATIONS_FILE,
  SESSION_ANNOTATIONS_VERSION,
  annotationCounts,
  annotationsOf,
  emptySessionAnnotations,
  normalizeSessionAnnotations,
  pluginDataDir,
  readAllSessionAnnotations,
  readSessionAnnotations,
  resolveAnnotationOptions,
  sessionAnnotationsExists,
  sessionAnnotationsPath,
  setSessionAnnotations,
  toggleSessionAnnotation,
  writeSessionAnnotations,
  PluginManager,
  HookRegistry,
  ServiceContainer,
  createServiceToken,
  loadFilePlugins,
  inspectPlugins,
  loadUserPlugins,
  writePluginStatus,
  parsePluginManifest,
  createPluginSettingsStore,
  normalizePluginSettingValues,
  readPluginSettings,
  writePluginSettings,
  resolvePluginSettingsPath,
  validatePluginSettingValues,
  resolvePluginLlmConfig,
  isPluginLlmConfigured,
  describePluginLlm,
  pluginLlmSettingFields,
  PluginSettingsValidationError,
  createPluginLogger,
  PLUGIN_HEALTH_DIR,
  createPluginHealthStore,
  readPluginHealth,
  writePluginHealth,
  clearPluginHealth,
  resolvePluginHealthPath,
  PluginPromptSections,
  PluginPanelRegistry,
  normalizePluginPanelAction,
  normalizePluginPanelActionResult,
  normalizePluginPanelView,
  PluginActionRegistry,
  PluginSessionMenuRegistry,
  normalizePluginSessionMenuInput,
  normalizePluginSessionMenuResult,
  MAX_PLUGIN_STATE_BYTES,
  normalizePluginStateRecord,
  validatePluginStateValue,
  pluginLogDir,
  pluginLogPath,
  readPluginState,
  readDisabledPluginIds,
  writePluginState,
  setPluginDisabled,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_API_VERSION,
  PLUGIN_SETTINGS_DIR,
  PLUGIN_STATE_FILE,
  PLUGIN_SKILLS_DIR,
  publishPluginSkills,
  readPublishedPluginSkills,
  resolvePluginSkillsDir,
};

export type { Plugin } from './Plugin.js';
export type { MicaPlugin } from './Plugin.js';
export {
  PluginPanelRegistry,
  normalizePluginPanelAction,
  normalizePluginPanelActionResult,
  normalizePluginPanelView,
} from './PluginPanel.js';
export {
  PLUGIN_ACTION_TONES,
  PluginActionRegistry,
} from './PluginActions.js';
export type {
  PluginActionDeclaration,
  PluginActionHandler,
  PluginActionInput,
  PluginActionResult,
  PluginActionTone,
} from './PluginActions.js';
export {
  PluginSessionMenuRegistry,
  normalizePluginSessionMenuInput,
  normalizePluginSessionMenuResult,
} from './PluginSessionMenu.js';
export type {
  PluginSessionMenuHandler,
  PluginSessionMenuInput,
  PluginSessionMenuItem,
  PluginSessionMenuRegistration,
  PluginSessionMenuResult,
} from './PluginSessionMenu.js';
export { loadUserPlugins } from './UserPlugins.js';
export { writePluginStatus } from './PluginStatus.js';
export type { PluginHostKind, PluginStatusEntry, PluginStatusFile } from './PluginStatus.js';
export {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_ENTRY_CANDIDATES,
  isSafePluginRelativePath,
  parsePluginManifest,
} from './PluginManifest.js';
export {
  PLUGIN_SETTINGS_DIR,
  createPluginSettingsStore,
  isPluginSettingType,
  isValidPluginSettingKey,
  normalizePluginSettingValues,
  readPluginSettings,
  resolvePluginSettingsPath,
  writePluginSettings,
  validatePluginSettingValues,
  PluginSettingsValidationError,
} from './PluginSettings.js';
export type {
  PluginSettingField,
  PluginSettingOption,
  PluginSettingType,
  PluginSettingValues,
  PluginSettingsStore,
} from './PluginSettings.js';
export { createPluginLogger, pluginLogDir, pluginLogPath } from './PluginLog.js';
export type { PluginLogOptions, PluginLogger } from './PluginLog.js';
export {
  PLUGIN_STATE_FILE,
  normalizePluginState,
  readDisabledPluginIds,
  readPluginState,
  resolvePluginStatePath,
  setPluginDisabled,
  writePluginState,
} from './PluginState.js';
export type { PluginBaseContext, PluginManager, PluginSetupReport } from './PluginManager.js';
export {
  PLUGIN_SKILLS_DIR,
  publishPluginSkills,
  readPublishedPluginSkills,
  resolvePluginSkillsDir,
} from './PluginSkills.js';
export type { PublishedPluginSkill } from './PluginSkills.js';
export type { PluginContext } from './PluginContext.js';
export type {
  PluginFileMentionItem,
  PluginFileMentionProvider,
  PluginNoticeOptions,
  PluginSessionApi,
  PluginSessionInfo,
  PluginSessionRenameOptions,
  PluginStatusItem,
  PluginToolRegistrationOptions,
} from './PluginContext.js';
export type { PluginPromptSection } from './PluginPrompt.js';
export type {
  PluginBackgroundApi,
  PluginBackgroundState,
  PluginBackgroundTask,
} from './PluginBackground.js';
export { createPluginBackgroundScheduler } from './PluginBackground.js';
export { PluginPromptSections } from './PluginPrompt.js';
export { DESKTOP_CHECKS, DESKTOP_CHECK_IDS, isDesktopCheckId } from './PluginDesktop.js';
export type {
  DesktopCheckDefinition,
  DesktopCheckId,
  PluginDesktopApi,
  PluginDesktopEntry,
  PluginDesktopRequirements,
  PluginSkillDefinition,
  PluginSkillRegistration,
  PluginSkillsApi,
} from './PluginDesktop.js';
export type { PluginStatusField, PluginStatusType } from './PluginManifest.js';
export type {
  PluginSubagentApi,
  PluginSubagentAwaitOptions,
  PluginSubagentCaller,
  PluginSubagentContextMode,
  PluginSubagentRegistry,
  PluginSubagentRunResult,
  PluginSubagentSpawnRequest,
  PluginSubagentTaskHandle,
  PluginSubagentTaskSnapshot,
  PluginSubagentTaskStatus,
  PluginSubagentThread,
  PluginSubagentThreadAskOptions,
  PluginSubagentThreadOptions,
  PluginSubagentThreadUsage,
  PluginSubagentType,
  PluginSubagentWriteMode,
} from './PluginSubagents.js';
export type {
  PluginAgentHandle,
  PluginAgentRegistry,
  PluginAgentUsage,
  PluginCompactMode,
  PluginCompactResult,
  PluginIdleCompactHook,
  PluginIdleCompactOutcome,
  PluginIterationRewriter,
} from './PluginAgent.js';
export type {
  PluginModelProtocol,
  PluginModelRequest,
  PluginModelResult,
  PluginModelUsage,
  PluginModelsApi,
  PluginModelsHandler,
} from './PluginModels.js';
export {
  PLUGIN_LLM_PROTOCOLS,
  PLUGIN_LLM_SETTING_KEYS,
  DEFAULT_PLUGIN_LLM_PROTOCOL,
  createPluginLlmApi,
  describePluginLlm,
  expandEnvPlaceholders,
  isPluginLlmConfigured,
  isPluginLlmSettingKey,
  pluginLlmSettingFields,
  resolvePluginLlmConfig,
} from './PluginLlm.js';
export type {
  CreatePluginLlmApiOptions,
  PluginLlmApi,
  PluginLlmConfig,
  PluginLlmRequest,
  PluginLlmSpec,
} from './PluginLlm.js';
export {
  PLUGIN_HEALTH_DIR,
  readPluginHealth,
  writePluginHealth,
  clearPluginHealth,
  createPluginHealthStore,
  resolvePluginHealthPath,
} from './PluginHealth.js';
export type { PluginHealthLevel, PluginHealthReport, PluginHealthStore } from './PluginHealth.js';
export type {
  PluginPanelAction,
  PluginPanelActionInput,
  PluginPanelButtonTone,
  PluginPanelField,
  PluginPanelHandler,
  PluginPanelItem,
  PluginPanelItemAction,
  PluginPanelRegistration,
  PluginPanelRow,
  PluginPanelSection,
  PluginPanelTone,
  PluginPanelView,
  PluginPanelViewInput,
} from './PluginPanel.js';
export type { PluginSettingIssue } from './PluginSettings.js';
export { PLUGIN_REQUIREMENTS, isPluginRequirement } from './PluginManifest.js';
export type { PluginRequirement } from './PluginManifest.js';
export { MAX_PLUGIN_STATE_BYTES, normalizePluginStateRecord, validatePluginStateValue } from './PluginSessionState.js';
export type { PluginSessionStateApi, PluginStateRecord } from './PluginSessionState.js';
export {
  MAX_PLUGIN_SESSION_SETTINGS_BYTES,
  createPluginSessionSettingsApi,
  mergeSessionSettingOverrides,
  normalizePluginSessionSettingsRecord,
  resolveEffectiveSettingValues,
  sessionScopedSettingFields,
  validateSessionSettingValues,
} from './PluginSessionSettings.js';
export type {
  PluginSessionSettingsApi,
  PluginSessionSettingsHostApi,
  PluginSessionSettingsRecord,
  PluginSessionSettingsView,
} from './PluginSessionSettings.js';
export type { HookRegistry } from './HookRegistry.js';
export type { AgentObservationEvent } from './AgentObservation.js';
export type { GuardHookResult, HookExecutionContext, HookHandler, HookKind, HookOptions } from './HookTypes.js';
export type { ServiceContainer } from './ServiceContainer.js';
export type { ServiceToken } from './ServiceToken.js';
export type {
  FilePluginLoaderOptions,
  FilePluginLoadResult,
  LoadedFilePlugin,
  PluginInspection,
  PluginInspectionResult,
} from './FilePluginLoader.js';
export type { PluginManifest, PluginManifestParseResult } from './PluginManifest.js';
export type { PluginState, PluginStateOptions } from './PluginState.js';
export {
  PLUGIN_DATA_DIR,
  SESSION_ANNOTATIONS_FILE,
  SESSION_ANNOTATIONS_VERSION,
  annotationCounts,
  annotationsOf,
  emptySessionAnnotations,
  normalizeSessionAnnotations,
  pluginDataDir,
  readAllSessionAnnotations,
  readSessionAnnotations,
  resolveAnnotationOptions,
  sessionAnnotationsExists,
  sessionAnnotationsPath,
  setSessionAnnotations,
  toggleSessionAnnotation,
  writeSessionAnnotations,
} from './sessionAnnotations.js';
export type { SessionAnnotationOption, SessionAnnotations, SessionAnnotationsProvider } from './sessionAnnotations.js';
