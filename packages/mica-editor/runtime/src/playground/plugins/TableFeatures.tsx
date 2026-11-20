import type { JSX } from 'react';

import TableCellResizer from './TableCellResizer';
import TableControlsPlugin from './TableControlsPlugin';
import TableFitNestedTablePlugin from './TableFitNestedTablePlugin';
import TableScrollShadowPlugin from './TableScrollShadowPlugin';
import MarkdownTableLayoutPlugin, {
  MARKDOWN_TABLE_MIN_COLUMN_WIDTH,
  MARKDOWN_TABLE_MIN_ROW_HEIGHT,
} from '../../markdown/markdownTableLayout';

export default function TableFeatures({
  markdownOnly = false,
  hasFitNestedTables = false,
}: {
  markdownOnly?: boolean;
  hasFitNestedTables?: boolean;
}): JSX.Element {
  return (
    <>
      {!markdownOnly && hasFitNestedTables ? <TableFitNestedTablePlugin /> : null}
      <TableCellResizer
        initializeColumnWidths={false}
        {...(markdownOnly
          ? {
              minColumnWidth: MARKDOWN_TABLE_MIN_COLUMN_WIDTH,
              minRowHeight: MARKDOWN_TABLE_MIN_ROW_HEIGHT,
            }
          : {})}
      />
      <MarkdownTableLayoutPlugin fill={!markdownOnly} />
      <TableControlsPlugin {...(markdownOnly ? { markdownOnly: true } : {})} />
      <TableScrollShadowPlugin />
    </>
  );
}
