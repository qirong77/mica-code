import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Box, Text } from '@anthropic/ink';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaRuntime, type MemoryUsageSnapshot } from '@packages/mica-runtime/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from './services.js';

const PANEL_ID = 'memory-usage-panel';
const EXPORT_FILES = ['manifest.log', 'diagnostics.log', 'memory-usage.log', 'memory-usage-summary.log'] as const;

type MemoryMetricKey = keyof MemoryUsageSnapshot['memory'];

const MEMORY_ROWS: Array<{ key: MemoryMetricKey; label: string }> = [
  { key: 'rss', label: 'RSS' },
  { key: 'heapUsed', label: 'JS heap used' },
  { key: 'heapTotal', label: 'JS heap total' },
  { key: 'external', label: 'External' },
  { key: 'arrayBuffers', label: 'ArrayBuffers' },
];

export function createMemoryUsageCommand(services: CommandRuntimeServices) {
  return {
    name: 'memoryUsage',
    description: '显示当前进程内存快照；/memoryUsage export 导出内存日志',
    completionItems: [{ arg: 'export', description: '导出内存快照日志' }],
    action: (arg?: string) => {
      const normalized = arg?.trim().toLowerCase();
      if (normalized === 'export') {
        micaRuntime.memoryUsageMonitor.capture('command:export');
        exportMemoryUsageLog(services);
        return;
      }

      micaRuntime.memoryUsageMonitor.capture('command:open');
      micaLogger.logRuntime('plugin.memoryUsage', 'opened', {
        snapshots: micaRuntime.memoryUsageMonitor.getSnapshots().length,
        running: micaRuntime.memoryUsageMonitor.isRunning(),
      });
      showMemoryUsagePanel();
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showMemoryUsagePanel() {
  const initialText = micaUi.terminalInput.text.get();

  function hide() {
    if (micaUi.panels.removePluginUI(PANEL_ID)) micaLogger.logRuntime('plugin.memoryUsage', 'closed');
  }

  function MemoryUsagePanel() {
    const snapshots = micaUi.useScheduleState(micaRuntime.memoryUsageMonitor.snapshots);
    const latest = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    const first = snapshots[0];

    return (
      <micaUi.Dialog
        title={`memoryUsage (${snapshots.length})`}
        footer={<micaUi.KeyHints hints={['esc exit', 'type to close']} />}
      >
        <Box flexDirection="column" width={86} maxWidth="100%" minWidth={0}>
          {!latest ? (
            <Text dimColor>no memory snapshots</Text>
          ) : (
            <>
              <Text color={micaUi.theme.colors.dim}>{formatSnapshotHeader(latest)}</Text>
              <Text color={micaUi.theme.colors.dim}>{formatMonitorHeader(snapshots.length)}</Text>
              <Text> </Text>
              <MemoryTable latest={latest} previous={previous} first={first} />
              <Text> </Text>
              <ResourceSummary snapshot={latest} />
            </>
          )}
        </Box>
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: MemoryUsagePanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (!key.escape) return false;
      hide();
      return true;
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function MemoryTable({
  latest,
  previous,
  first,
}: {
  latest: MemoryUsageSnapshot;
  previous?: MemoryUsageSnapshot;
  first?: MemoryUsageSnapshot;
}) {
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color={micaUi.theme.colors.textSecondary}>{formatTableHeader()}</Text>
      <Text color={micaUi.theme.colors.dim}>{'-'.repeat(72)}</Text>
      {MEMORY_ROWS.map((row) => {
        const current = latest.memory[row.key];
        const fromStart = first ? current - first.memory[row.key] : 0;
        const fromPrevious = previous ? current - previous.memory[row.key] : 0;
        return (
          <Text key={row.key} color={rowColor(row.key, latest)}>
            {formatMemoryRow(row.label, current, fromStart, fromPrevious)}
          </Text>
        );
      })}
      <Text color={micaUi.theme.colors.dim}>{'-'.repeat(72)}</Text>
      <Text>{formatHeapPressure(latest)}</Text>
    </Box>
  );
}

function ResourceSummary({ snapshot }: { snapshot: MemoryUsageSnapshot }) {
  const usage = snapshot.resourceUsage;
  if (!usage) return <Text dimColor>resourceUsage unavailable</Text>;
  const maxRss = typeof usage.maxRSS === 'number' ? formatBytes(usage.maxRSS) : '-';
  const minor = typeof usage.minorPageFault === 'number' ? formatInteger(usage.minorPageFault) : '-';
  const major = typeof usage.majorPageFault === 'number' ? formatInteger(usage.majorPageFault) : '-';
  const voluntary =
    typeof usage.voluntaryContextSwitches === 'number' ? formatInteger(usage.voluntaryContextSwitches) : '-';
  const involuntary =
    typeof usage.involuntaryContextSwitches === 'number' ? formatInteger(usage.involuntaryContextSwitches) : '-';

  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color={micaUi.theme.colors.textSecondary}>Resource usage</Text>
      <Text color={micaUi.theme.colors.dim}>{`Max RSS: ${maxRss}   Page faults: ${minor}/${major}`}</Text>
      <Text color={micaUi.theme.colors.dim}>{`Context switches: ${voluntary}/${involuntary}`}</Text>
    </Box>
  );
}

function exportMemoryUsageLog(services: CommandRuntimeServices): void {
  micaLogger.logRuntime('plugin.memoryUsage', 'export:requested');

  try {
    const snapshots = micaRuntime.memoryUsageMonitor.getSnapshots();
    const exportedAt = new Date();
    const cwd = process.cwd();
    const exportDirName = `mica-memory-usage-export-${formatTimestampForPath(exportedAt)}`;
    const exportDir = resolve(cwd, exportDirName);
    mkdirSync(exportDir, { recursive: false });

    const diagnostics = {
      exportedAt: exportedAt.toISOString(),
      cwd,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      bun: process.versions.bun,
      uptimeSec: process.uptime(),
      monitor: {
        running: micaRuntime.memoryUsageMonitor.isRunning(),
        startedAt: formatOptionalIso(micaRuntime.memoryUsageMonitor.getStartedAt()),
        intervalMs: micaRuntime.memoryUsageMonitor.getIntervalMs(),
        maxSnapshots: micaRuntime.memoryUsageMonitor.getMaxSnapshots(),
      },
    };
    const exportData = {
      exportedAt: exportedAt.toISOString(),
      totalSnapshots: snapshots.length,
      firstAt: snapshots[0]?.atIso ?? null,
      latestAt: snapshots[snapshots.length - 1]?.atIso ?? null,
      snapshots,
    };
    const manifest = {
      exportedAt: exportedAt.toISOString(),
      files: [...EXPORT_FILES],
      counts: {
        snapshots: snapshots.length,
      },
      notes: [
        'memory-usage.log contains process.memoryUsage() snapshots in bytes.',
        'RSS is not the same metric as macOS Activity Monitor memory footprint.',
      ],
    };

    writeJsonFile(exportDir, 'manifest.log', manifest);
    writeJsonFile(exportDir, 'diagnostics.log', diagnostics);
    writeJsonFile(exportDir, 'memory-usage.log', exportData);
    writeFileSync(join(exportDir, 'memory-usage-summary.log'), formatSummaryLog(snapshots), 'utf-8');

    services.showMessage(`memoryUsage export: 已导出 ${snapshots.length} 条快照 -> ${exportDirName}`, 8000);
    micaLogger.logRuntime('plugin.memoryUsage', 'export:done', {
      path: exportDirName,
      snapshots: snapshots.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`memoryUsage export: 导出失败：${message}`, 8000);
    micaLogger.logRuntime('plugin.memoryUsage', 'export:error', { message }, 'error');
  }
}

function formatSummaryLog(snapshots: MemoryUsageSnapshot[]): string {
  const lines = [
    [
      'Time'.padEnd(24),
      'Label'.padEnd(16),
      'RSS'.padStart(9),
      'HeapUsed'.padStart(9),
      'HeapTotal'.padStart(9),
      'External'.padStart(9),
      'ArrayBuffers'.padStart(12),
    ].join('  '),
  ];
  for (const snapshot of snapshots) {
    lines.push(
      [
        snapshot.atIso,
        snapshot.label.padEnd(16),
        formatBytes(snapshot.memory.rss).padStart(9),
        formatBytes(snapshot.memory.heapUsed).padStart(9),
        formatBytes(snapshot.memory.heapTotal).padStart(9),
        formatBytes(snapshot.memory.external).padStart(9),
        formatBytes(snapshot.memory.arrayBuffers).padStart(12),
      ].join('  '),
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatTableHeader(): string {
  return ['Metric'.padEnd(16), 'Current'.padStart(9), 'Since start'.padStart(12), 'Previous'.padStart(10)].join('  ');
}

function formatMemoryRow(label: string, current: number, fromStart: number, fromPrevious: number): string {
  return [
    label.padEnd(16),
    formatBytes(current).padStart(9),
    formatDeltaBytes(fromStart).padStart(12),
    formatDeltaBytes(fromPrevious).padStart(10),
  ].join('  ');
}

function formatHeapPressure(snapshot: MemoryUsageSnapshot): string {
  const { heapUsed, heapTotal } = snapshot.memory;
  if (heapTotal <= 0) return 'JS heap pressure : -';
  const ratio = heapUsed / heapTotal;
  return `JS heap pressure : ${(ratio * 100).toFixed(1)}%`;
}

function formatSnapshotHeader(snapshot: MemoryUsageSnapshot): string {
  return `latest: ${formatTime(snapshot.at)}   label: ${snapshot.label}   pid: ${snapshot.pid}   uptime: ${formatDuration(snapshot.uptimeSec * 1000)}`;
}

function formatMonitorHeader(count: number): string {
  const running = micaRuntime.memoryUsageMonitor.isRunning() ? 'on' : 'off';
  const intervalSec = micaRuntime.memoryUsageMonitor.getIntervalMs() / 1000;
  return `monitor: ${running}   interval: ${formatFixed(intervalSec, 1)}s   retained: ${count}/${micaRuntime.memoryUsageMonitor.getMaxSnapshots()}`;
}

function rowColor(key: MemoryMetricKey, snapshot: MemoryUsageSnapshot): string | undefined {
  if (key !== 'heapUsed') return undefined;
  const ratio = snapshot.memory.heapTotal > 0 ? snapshot.memory.heapUsed / snapshot.memory.heapTotal : 0;
  if (ratio >= 0.85) return micaUi.theme.colors.warning;
  return undefined;
}

function writeJsonFile(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${formatFixed(bytes, 0)}B`;
  if (abs < 1024 * 1024) return `${formatFixed(bytes / 1024, 1)}KB`;
  if (abs < 1024 * 1024 * 1024) return `${formatFixed(bytes / (1024 * 1024), 1)}MB`;
  return `${formatFixed(bytes / (1024 * 1024 * 1024), 2)}GB`;
}

function formatDeltaBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  return `${bytes > 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$|(?<=\.\d*[1-9])0+$/u, '');
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatOptionalIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function formatTimestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
