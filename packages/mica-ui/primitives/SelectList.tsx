import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { DOMElement } from '@packages/@anthropic/ink/src/core/dom.js';
import type { ScrollBoxHandle } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import { themeColors } from '../theme.js';
import { OneLineItem } from './OneLineItem.js';
import { BottomScrollBox } from './BottomScrollBox.js';

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
  layout?: SelectListLayout;
  showIndex?: boolean;
  highlightText?: string;
  height?: number;
  maxHeight?: number;
  bottomReservedRows?: number;
  renderItem?: (item: T, isSelected: boolean, index: number) => React.ReactNode;
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
  selectedItemRef: (el: DOMElement | null) => void,
  renderItem?: (item: T, isSelected: boolean, index: number) => React.ReactNode,
) {
  const indexWidth = showIndex ? String(items.length).length + 2 : 0;

  return items.map((item, index) => {
    const isSelected = index === selectedIdx;
    return (
      <Box
        key={item.key}
        ref={isSelected ? selectedItemRef : undefined}
        flexDirection="row"
        width="100%"
        minWidth={0}
        marginBottom={index < items.length - 1 ? itemGap : 0}
      >
        <Box width={markerWidth} flexShrink={0}>
          <Text color={isSelected ? themeColors.accent : themeColors.subtle}>{isSelected ? marker : ' '}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {renderItem ? (
            renderItem(item, isSelected, index)
          ) : (
            <DefaultSelectItem
              item={item}
              isSelected={isSelected}
              index={index + 1}
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
  layout = 'table',
  showIndex = false,
  highlightText,
  height,
  maxHeight,
  bottomReservedRows = 4,
  renderItem,
}: SelectListProps<T>): React.ReactNode {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const selectedItemRef = useRef<DOMElement | null>(null);
  const selectedItemRefCallback = useMemo(
    () => (el: DOMElement | null) => {
      selectedItemRef.current = el;
    },
    [],
  );
  const clampedSelectedIdx = clampIndex(selectedIdx, items.length);
  const selectedKey = items[clampedSelectedIdx]?.key;

  useLayoutEffect(() => {
    const scrollBox = scrollRef.current;
    const selectedItem = selectedItemRef.current;
    if (!scrollBox || !selectedItem || items.length === 0) return;

    const viewportHeight = scrollBox.getViewportHeight();
    if (viewportHeight <= 0) {
      scrollBox.scrollToElement(selectedItem);
      return;
    }

    const selectedTop = selectedItem.yogaNode?.getComputedTop();
    if (selectedTop === undefined) return;

    const selectedHeight = selectedItem.yogaNode?.getComputedHeight() ?? 1;
    const scrollTop = scrollBox.getScrollTop();
    const scrollBottom = scrollTop + viewportHeight;
    const selectedBottom = selectedTop + selectedHeight;

    if (selectedTop < scrollTop) {
      scrollBox.scrollToElement(selectedItem);
    } else if (selectedBottom > scrollBottom) {
      scrollBox.scrollToElement(
        selectedItem,
        selectedHeight >= viewportHeight ? 0 : -(viewportHeight - selectedHeight),
      );
    }
  }, [clampedSelectedIdx, height, items.length, maxHeight, selectedKey]);

  const body = (
    <BottomScrollBox
      ref={scrollRef}
      height={height}
      maxHeight={maxHeight}
      bottomReservedRows={bottomReservedRows}
      stickyScroll={false}
    >
      {items.length === 0 ? (
        empty
      ) : (
        <Box flexDirection="column" width="100%" minWidth={0}>
          {renderItems(
            items,
            clampedSelectedIdx,
            itemGap,
            markerWidth,
            marker,
            layout,
            showIndex,
            highlightText,
            selectedItemRefCallback,
            renderItem,
          )}
        </Box>
      )}
    </BottomScrollBox>
  );

  if (!title) return body;
  return (
    <Box flexDirection="column" minWidth={0} width="100%">
      <Box paddingBottom={1}>{typeof title === 'string' ? <Text dimColor>{title}</Text> : title}</Box>
      {body}
    </Box>
  );
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
