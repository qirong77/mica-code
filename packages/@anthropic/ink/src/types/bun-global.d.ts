declare var Bun:
  | {
      stringWidth(str: string, opts?: { ambiguousIsNarrow?: boolean }): number;
      wrapAnsi(
        input: string,
        columns: number,
        options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean },
      ): string;
      [key: string]: any;
    }
  | undefined;
