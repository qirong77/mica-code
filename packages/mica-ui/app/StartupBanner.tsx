import React from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { startupBanner } from '../panels/state.js';
import type { MicaUiStartupBannerState } from '../types.js';

const DEFAULT_FRAME_WIDTH = 56;
const MIN_FRAME_WIDTH = 4;
const FRAME_CHROME_WIDTH = 4;
const BORDER_CHROME_WIDTH = 2;
const TWO_COLUMN_MIN_CONTENT_WIDTH = 44;
const COLUMN_GAP = 4;
const LABEL_WIDTH = 8;
const LABEL_VALUE_GAP = 2;
const MIN_VALUE_WIDTH = 4;
const RULE_CHAR = '─';

type StartupBannerMode = 'two-column' | 'single-column';
type StartupBannerFieldKey = keyof Omit<MicaUiStartupBannerState, 'tips'>;

type StartupBannerField = {
  label: string;
  key: StartupBannerFieldKey;
};

type StartupBannerRow = readonly [StartupBannerField, StartupBannerField];

export interface StartupBannerLayout {
  frameWidth: number;
  ruleWidth: number;
  contentWidth: number;
  mode: StartupBannerMode;
  columnGap: number;
  columnWidths: readonly [number, number];
  singlePairWidth: number;
}

export interface StartupBannerPairLayout {
  labelWidth: number;
  gapWidth: number;
  valueWidth: number;
}

const STARTUP_BANNER_ROWS = [
  [
    { label: 'Provider', key: 'provider' },
    { label: 'Model', key: 'model' },
  ],
  [
    { label: 'Context', key: 'context' },
    { label: 'Effort', key: 'effort' },
  ],
  [
    { label: 'Tools', key: 'tools' },
    { label: 'MCP', key: 'mcp' },
  ],
  [
    { label: 'Session', key: 'session' },
    { label: 'Workdir', key: 'workdir' },
  ],
] as const satisfies readonly StartupBannerRow[];

export function StartupBanner(): React.ReactNode {
  const state = useScheduleState(startupBanner);
  const { columns } = useTerminalSize();

  return <StartupBannerView state={state} terminalColumns={columns} />;
}

export function StartupBannerView({
  state,
  terminalColumns,
}: {
  state: MicaUiStartupBannerState;
  terminalColumns?: number;
}): React.ReactNode {
  const layout = getStartupBannerLayout(terminalColumns);

  return (
    <Box flexDirection="column" width={layout.frameWidth} minWidth={0} overflowX="hidden" paddingBottom={1}>
      <Border layout={layout} left="╭" right="╮" />
      <HeaderLine layout={layout} text="✦ Mica Code" color={themeColors.primary} bold />
      <HeaderLine layout={layout} text="  Minimal, Intelligent, Cache-first Agent" color={themeColors.dim} />
      <Border layout={layout} left="├" right="┤" />
      <InfoGrid layout={layout} state={state} />
      <Border layout={layout} left="├" right="┤" />
      <TipLine layout={layout} tip={state.tips} />
      <Border layout={layout} left="╰" right="╯" />
    </Box>
  );
}

export function getStartupBannerLayout(terminalColumns: number | undefined): StartupBannerLayout {
  const availableWidth =
    typeof terminalColumns === 'number' && Number.isFinite(terminalColumns) && terminalColumns > 0
      ? Math.floor(terminalColumns)
      : DEFAULT_FRAME_WIDTH;
  const frameWidth = Math.max(MIN_FRAME_WIDTH, Math.min(DEFAULT_FRAME_WIDTH, availableWidth));
  const contentWidth = Math.max(0, frameWidth - FRAME_CHROME_WIDTH);
  const mode: StartupBannerMode = contentWidth >= TWO_COLUMN_MIN_CONTENT_WIDTH ? 'two-column' : 'single-column';
  const columnGap = mode === 'two-column' ? Math.min(COLUMN_GAP, Math.max(0, contentWidth - MIN_VALUE_WIDTH * 2)) : 0;
  const leftColumnWidth = mode === 'two-column' ? Math.floor((contentWidth - columnGap) / 2) : contentWidth;
  const rightColumnWidth = mode === 'two-column' ? contentWidth - columnGap - leftColumnWidth : 0;

  return {
    frameWidth,
    ruleWidth: Math.max(0, frameWidth - BORDER_CHROME_WIDTH),
    contentWidth,
    mode,
    columnGap,
    columnWidths: [leftColumnWidth, rightColumnWidth],
    singlePairWidth: contentWidth,
  };
}

export function getStartupBannerPairLayout(width: number): StartupBannerPairLayout {
  const safeWidth = Math.max(0, Math.floor(width));
  const wideEnoughForDefaultGap = safeWidth >= LABEL_WIDTH + LABEL_VALUE_GAP + MIN_VALUE_WIDTH;
  const gapWidth = wideEnoughForDefaultGap ? LABEL_VALUE_GAP : Math.min(1, Math.max(0, safeWidth - MIN_VALUE_WIDTH));
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(0, safeWidth - gapWidth - MIN_VALUE_WIDTH));

  return {
    labelWidth,
    gapWidth,
    valueWidth: Math.max(0, safeWidth - labelWidth - gapWidth),
  };
}

export function buildStartupBannerRule(
  layout: Pick<StartupBannerLayout, 'ruleWidth'>,
  left: string,
  right: string,
): string {
  return `${left}${RULE_CHAR.repeat(layout.ruleWidth)}${right}`;
}

function Border({
  layout,
  left,
  right,
}: {
  layout: StartupBannerLayout;
  left: string;
  right: string;
}): React.ReactNode {
  return (
    <Box width={layout.frameWidth} minWidth={0} overflowX="hidden">
      <Text color={themeColors.dim} wrap="truncate-end">
        {buildStartupBannerRule(layout, left, right)}
      </Text>
    </Box>
  );
}

function BannerLine({ layout, children }: { layout: StartupBannerLayout; children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="row" width={layout.frameWidth} minWidth={0} overflowX="hidden">
      <Text color={themeColors.dim}>│ </Text>
      <Box width={layout.contentWidth} minWidth={0} overflowX="hidden">
        {children}
      </Box>
      <Text color={themeColors.dim}> │</Text>
    </Box>
  );
}

function HeaderLine({
  layout,
  text,
  color,
  bold,
}: {
  layout: StartupBannerLayout;
  text: string;
  color?: string;
  bold?: boolean;
}): React.ReactNode {
  return (
    <BannerLine layout={layout}>
      <Text color={color} bold={bold} wrap="truncate-end">
        {text}
      </Text>
    </BannerLine>
  );
}

function InfoGrid({
  layout,
  state,
}: {
  layout: StartupBannerLayout;
  state: MicaUiStartupBannerState;
}): React.ReactNode {
  if (layout.mode === 'single-column') {
    return (
      <>
        {STARTUP_BANNER_ROWS.flat().map((field) => (
          <BannerLine key={field.key} layout={layout}>
            <InfoPair label={field.label} value={state[field.key]} width={layout.singlePairWidth} />
          </BannerLine>
        ))}
      </>
    );
  }

  return (
    <>
      {STARTUP_BANNER_ROWS.map(([left, right]) => (
        <BannerLine key={`${left.key}-${right.key}`} layout={layout}>
          <Box
            flexDirection="row"
            width={layout.contentWidth}
            minWidth={0}
            overflowX="hidden"
            columnGap={layout.columnGap}
          >
            <InfoPair label={left.label} value={state[left.key]} width={layout.columnWidths[0]} />
            <InfoPair label={right.label} value={state[right.key]} width={layout.columnWidths[1]} />
          </Box>
        </BannerLine>
      ))}
    </>
  );
}

function TipLine({ layout, tip }: { layout: StartupBannerLayout; tip: string }): React.ReactNode {
  return (
    <BannerLine layout={layout}>
      <InfoPair label="Tips" value={tip} width={layout.contentWidth} />
    </BannerLine>
  );
}

function InfoPair({ label, value, width }: { label: string; value: string; width: number }): React.ReactNode {
  const layout = getStartupBannerPairLayout(width);

  return (
    <Box flexDirection="row" width={width} minWidth={0} overflowX="hidden" columnGap={layout.gapWidth}>
      {layout.labelWidth > 0 ? (
        <Box width={layout.labelWidth} minWidth={0} overflowX="hidden">
          <Text wrap="truncate-end">{label}</Text>
        </Box>
      ) : null}
      <Box width={layout.valueWidth} minWidth={0} overflowX="hidden">
        <Text wrap="truncate-end">{value || '-'}</Text>
      </Box>
    </Box>
  );
}

export const StartupBannerUI = { renderFn: StartupBanner };
