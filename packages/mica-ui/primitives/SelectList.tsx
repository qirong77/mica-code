import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { useBottomPanelHeight } from '../hooks/useLogViewHeight.js';
import { OneLineItem } from './OneLineItem.js';

export type SelectListLayout = 'compact' | 'detail' | 'table';

export interface SelectItem {
  key: string;
  label: React.ReactNode;
  status?: React.ReactNode;
  description?: React.ReactNode;
  suffix?: React.ReactNode;
  labelWidth?: number | string;
  labelMaxWidth?: number | string;
  disabled?: boolean;
}

export interface SelectListProps<T extends SelectItem> {
  items: T[];
  selectedIdx: number;
  title?: React.ReactNode;
  empty?: React.ReactNode;
  itemGap?: number;
  markerWidth?: number;
  marker?: string;
  maxVisibleItems?: number;
  adaptiveHeight?: boolean;
  reservedRows?: number;
  layout?: SelectListLayout;
  showIndex?: boolean;
  highlightText?: string;
  scrollIndicators?: boolean;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}

function renderItems<T extends SelectItem>(
  items: T[],
  selectedIdx: number,
  itemGap: number,
  markerWidth: number,
  marker: string,
  layout: SelectListLayout,
  showIndex: boolean,
  highlightText: string | undefined,
  scrollIndicators: boolean,
  range: { start: number; end: number; total: number },
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode,
) {
  const indexWidth = showIndex ? String(range.total).length + 2 : 0;
  const hasAbove = range.start > 0;
  const hasBelow = range.end < range.total;

  return items.map((item, localIndex) => {
    const absoluteIndex = range.start + localIndex;
    const isSelected = absoluteIndex === selectedIdx;
    const isFirstVisible = localIndex === 0;
    const isLastVisible = localIndex === items.length - 1;
    const scrollMarker =
      scrollIndicators && !isSelected && ((isFirstVisible && hasAbove) || (isLastVisible && hasBelow))
        ? isFirstVisible && hasAbove
          ? '↑'
          : '↓'
        : ' ';
    const markerText = isSelected ? marker : scrollMarker;

    return (
      <Box
        key={item.key}
        flexDirection="row"
        width="100%"
        minWidth={0}
        marginBottom={localIndex < items.length - 1 ? itemGap : 0}
      >
        <Box width={markerWidth} flexShrink={0}>
          <Text color={isSelected ? themeColors.accent : themeColors.subtle}>{markerText}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {renderItem ? (
            renderItem(item, isSelected)
          ) : (
            <DefaultSelectItem
              item={item}
              isSelected={isSelected}
              index={absoluteIndex + 1}
              indexWidth={indexWidth}
              layout={layout}
              showIndex={showIndex}
              highlightText={highlightText}
            />
          )}
        </Box>
      </Box>
    );
  });
}

function DefaultSelectItem({
  item,
  isSelected,
  index,
  indexWidth,
  layout,
  showIndex,
  highlightText,
}: {
  item: SelectItem;
  isSelected: boolean;
  index: number;
  indexWidth: number;
  layout: SelectListLayout;
  showIndex: boolean;
  highlightText?: string;
}): React.ReactNode {
  const hasDescription = item.description !== undefined && item.description !== null && item.description !== '';
  const disabled = item.disabled === true;
  const selectedColor = disabled ? themeColors.inactive : themeColors.accent;
  const labelColor = isSelected ? selectedColor : disabled ? themeColors.inactive : undefined;
  const descriptionColor = isSelected ? selectedColor : disabled ? themeColors.inactive : undefined;
  const descriptionDim = !isSelected && !disabled;
  const label = renderSelectableContent(item.label, highlightText, labelColor, disabled, isSelected);
  const description = renderSelectableContent(item.description, highlightText, descriptionColor, descriptionDim, false);

  if (layout === 'detail' && hasDescription) {
    return (
      <Box flexDirection="column" minWidth={0}>
        <OneLineItem
          cells={[
            {
              key: 'status',
              content: item.status,
              flexShrink: 0,
            },
            {
              key: 'index',
              content: showIndex ? `${index}.` : undefined,
              width: indexWidth || undefined,
              flexShrink: 0,
              color: themeColors.subtle,
            },
            {
              key: 'label',
              content: label,
              width: item.labelWidth,
              maxWidth: item.labelMaxWidth,
              flexGrow: item.labelWidth ? 0 : 1,
              flexShrink: 1,
              minWidth: 0,
              color: typeof label === 'string' || typeof label === 'number' ? labelColor : undefined,
              bold: isSelected && !disabled,
            },
            {
              key: 'suffix',
              content: item.suffix,
              flexShrink: 0,
              color: isSelected ? selectedColor : undefined,
              dimColor: !isSelected,
            },
          ]}
        />
        <Box paddingLeft={(showIndex ? indexWidth : 0) + 1} minWidth={0}>
          {typeof description === 'string' || typeof description === 'number' ? (
            <Text color={descriptionColor} dimColor={descriptionDim} wrap="wrap">
              {description}
            </Text>
          ) : (
            description
          )}
        </Box>
      </Box>
    );
  }

  return (
    <OneLineItem
      cells={[
        {
          key: 'status',
          content: item.status,
          flexShrink: 0,
        },
        {
          key: 'index',
          content: showIndex ? `${index}.` : undefined,
          width: indexWidth || undefined,
          flexShrink: 0,
          color: themeColors.subtle,
        },
        {
          key: 'label',
          content: label,
          width: item.labelWidth,
          maxWidth: item.labelMaxWidth ?? (layout === 'table' && hasDescription ? '45%' : undefined),
          flexGrow: item.labelWidth ? 0 : layout === 'table' && hasDescription ? 0 : 1,
          flexShrink: 1,
          minWidth: 0,
          color: typeof label === 'string' || typeof label === 'number' ? labelColor : undefined,
          bold: isSelected && !disabled,
        },
        {
          key: 'description',
          content: description,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          color: typeof description === 'string' || typeof description === 'number' ? descriptionColor : undefined,
          dimColor: typeof description === 'string' || typeof description === 'number' ? descriptionDim : undefined,
        },
        {
          key: 'suffix',
          content: item.suffix,
          flexShrink: 0,
          color: isSelected ? selectedColor : undefined,
          dimColor: !isSelected,
        },
      ]}
    />
  );
}

function renderSelectableContent(
  content: React.ReactNode,
  highlightText: string | undefined,
  color: string | undefined,
  dimColor: boolean,
  bold: boolean,
): React.ReactNode {
  if (typeof content !== 'string' || !highlightText) return content;
  const haystack = content.toLowerCase();
  const needle = highlightText.toLowerCase();
  const index = needle ? haystack.indexOf(needle) : -1;
  if (index < 0) return content;

  return (
    <Text color={color} dimColor={dimColor} bold={bold}>
      {content.slice(0, index)}
      <Text color={color ?? themeColors.accent} bold underline>
        {content.slice(index, index + highlightText.length)}
      </Text>
      {content.slice(index + highlightText.length)}
    </Text>
  );
}

export function SelectList<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty = <Text dimColor>no items</Text>,
  itemGap = 1,
  markerWidth = 2,
  marker = '\u25B6',
  maxVisibleItems = 5,
  adaptiveHeight = true,
  reservedRows = title ? 1 : 0,
  layout = 'table',
  showIndex = false,
  highlightText,
  scrollIndicators = false,
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  const effectiveMarkerWidth = Math.max(markerWidth, scrollIndicators ? 1 : 0);

  if (adaptiveHeight) {
    return (
      <AdaptiveSelectList
        items={items}
        selectedIdx={selectedIdx}
        title={title}
        empty={empty}
        itemGap={itemGap}
        markerWidth={effectiveMarkerWidth}
        marker={marker}
        maxVisibleItems={maxVisibleItems}
        reservedRows={reservedRows}
        layout={layout}
        showIndex={showIndex}
        highlightText={highlightText}
        scrollIndicators={scrollIndicators}
        renderItem={renderItem}
      />
    );
  }

  return (
    <SelectListContent
      items={items}
      selectedIdx={selectedIdx}
      title={title}
      empty={empty}
      itemGap={itemGap}
      markerWidth={effectiveMarkerWidth}
      marker={marker}
      visibleItemLimit={maxVisibleItems}
      layout={layout}
      showIndex={showIndex}
      highlightText={highlightText}
      scrollIndicators={scrollIndicators}
      renderItem={renderItem}
    />
  );
}

function AdaptiveSelectList<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty,
  itemGap,
  markerWidth,
  marker,
  maxVisibleItems,
  reservedRows,
  layout,
  showIndex,
  highlightText,
  scrollIndicators,
  renderItem,
}: Omit<SelectListProps<T>, 'adaptiveHeight'> & {
  empty: React.ReactNode;
  itemGap: number;
  markerWidth: number;
  marker: string;
  maxVisibleItems: number;
  reservedRows: number;
  layout: SelectListLayout;
  showIndex: boolean;
  highlightText?: string;
  scrollIndicators: boolean;
}): React.ReactNode {
  // Adaptive mode lets the bottom panel grow into available terminal space;
  // maxVisibleItems remains a floor so callers still get a predictable minimum.
  const panelHeight = useBottomPanelHeight(reservedRows);
  const adaptiveVisibleItems = Math.max(1, Math.floor((panelHeight + itemGap) / (1 + itemGap)));
  const visibleItemLimit = Math.max(maxVisibleItems, adaptiveVisibleItems);

  return (
    <SelectListContent
      items={items}
      selectedIdx={selectedIdx}
      title={title}
      empty={empty}
      itemGap={itemGap}
      markerWidth={markerWidth}
      marker={marker}
      visibleItemLimit={visibleItemLimit}
      layout={layout}
      showIndex={showIndex}
      highlightText={highlightText}
      scrollIndicators={scrollIndicators}
      renderItem={renderItem}
    />
  );
}

function SelectListContent<T extends SelectItem>({
  items,
  selectedIdx,
  title,
  empty,
  itemGap,
  markerWidth,
  marker,
  visibleItemLimit,
  layout,
  showIndex,
  highlightText,
  scrollIndicators,
  renderItem,
}: {
  items: T[];
  selectedIdx: number;
  title?: React.ReactNode;
  empty: React.ReactNode;
  itemGap: number;
  markerWidth: number;
  marker: string;
  visibleItemLimit: number;
  layout: SelectListLayout;
  showIndex: boolean;
  highlightText?: string;
  scrollIndicators: boolean;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}): React.ReactNode {
  if (items.length === 0) return <>{empty}</>;

  // This component is intentionally height-agnostic: callers decide the item
  // limit, and the content layer only chooses between plain and windowed list.
  const body =
    items.length <= visibleItemLimit ? (
      <Box flexDirection="column" width="100%" minWidth={0}>
        {renderItems(
          items,
          selectedIdx,
          itemGap,
          markerWidth,
          marker,
          layout,
          showIndex,
          highlightText,
          false,
          { start: 0, end: items.length, total: items.length },
          renderItem,
        )}
      </Box>
    ) : (
      <ScrollBody
        items={items}
        selectedIdx={selectedIdx}
        visibleItems={visibleItemLimit}
        itemGap={itemGap}
        markerWidth={markerWidth}
        marker={marker}
        layout={layout}
        showIndex={showIndex}
        highlightText={highlightText}
        scrollIndicators={scrollIndicators}
        renderItem={renderItem}
      />
    );

  if (!title) return body;
  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>{typeof title === 'string' ? <Text dimColor>{title}</Text> : title}</Box>
      {body}
    </Box>
  );
}

function ScrollBody<T extends SelectItem>({
  items,
  selectedIdx,
  visibleItems,
  itemGap,
  markerWidth,
  marker,
  layout,
  showIndex,
  highlightText,
  scrollIndicators,
  renderItem,
}: {
  items: T[];
  selectedIdx: number;
  visibleItems: number;
  itemGap: number;
  markerWidth: number;
  marker: string;
  layout: SelectListLayout;
  showIndex: boolean;
  highlightText?: string;
  scrollIndicators: boolean;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
}) {
  const visibleRows = visibleItems + (visibleItems - 1) * itemGap;
  const range = getVisibleRange(items.length, selectedIdx, visibleItems);
  const visibleItemsSlice = items.slice(range.start, range.end);
  const heightProps = layout === 'detail' ? {} : { height: visibleRows };

  return (
    <Box {...heightProps} flexDirection="column" width="100%" minWidth={0}>
      {renderItems(
        visibleItemsSlice,
        selectedIdx,
        itemGap,
        markerWidth,
        marker,
        layout,
        showIndex,
        highlightText,
        scrollIndicators,
        { ...range, total: items.length },
        renderItem,
      )}
    </Box>
  );
}

function getVisibleRange(total: number, selectedIdx: number, visibleItems: number): { start: number; end: number } {
  const limit = Math.max(1, Math.min(total, visibleItems));
  const clampedSelected = Math.max(0, Math.min(selectedIdx, total - 1));
  const half = Math.floor(limit / 2);
  const maxStart = Math.max(0, total - limit);
  const start = Math.min(maxStart, Math.max(0, clampedSelected - half));
  return { start, end: Math.min(total, start + limit) };
}
