import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * 二维码：把一段文本（手机链接这类「扫一下就走」的地址）画成可扫的码。
 *
 * 编码归这里、码样也归这里，调用方只给内容。码固定是**深色 + 白底**：反色码（浅色前景、
 * 深色背景）在深色主题里看着更协调，但不少手机扫不出来——这一类码的用途就是让别人扫，
 * 好看排在能扫之后。所以不跟随主题取色。
 *
 * 只画一个 `<path>`：定位图案加上纠错数据之后，一个码几十乘几十个模块，逐个 `<rect>` 会
 * 在每次弹窗打开时生成上千个 DOM 节点。连续深色模块合成一段折线，path 只有一条。
 */

export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H';

/** 模块矩阵：`true` 是深色格。编码器按内容自动选版本，所以行列数不定。 */
export function qrModules(value: string, level: QrErrorLevel = 'M'): boolean[][] {
  const code = qrcode(0, level);
  code.addData(value);
  code.make();
  const count = code.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col += 1) line.push(code.isDark(row, col));
    rows.push(line);
  }
  return rows;
}

/** 矩阵 → 一条 path：每行里连续的深色格画成一段横条。 */
export function qrPath(modules: boolean[][]): string {
  let path = '';
  for (let row = 0; row < modules.length; row += 1) {
    const line = modules[row] ?? [];
    let col = 0;
    while (col < line.length) {
      if (!line[col]) {
        col += 1;
        continue;
      }
      let end = col;
      while (end < line.length && line[end]) end += 1;
      path += `M${col} ${row}h${end - col}v1H${col}z`;
      col = end;
    }
  }
  return path;
}

/**
 * 一个二维码。
 *
 * `size` 是码的边长（默认 216，够手机在一臂距离扫到）；静区（码周围的留白）是码本身的
 * 一部分，缺了会扫不出来，所以白底由组件自己铺一圈，不由调用方用 margin 补。
 */
export function QrCode({
  value,
  size = 216,
  label,
  className,
}: {
  value: string;
  size?: number;
  /** 读屏用的说明；不给就用「二维码」。 */
  label?: string;
  className?: string;
}) {
  const modules = useMemo(() => qrModules(value), [value]);
  const path = useMemo(() => qrPath(modules), [modules]);
  const count = modules.length || 1;
  // 静区按规范留 4 个模块：手机靠这圈白边找到码的边界，给 2 也能扫，但远一点就不稳。
  const quiet = 4;
  return (
    <svg
      className={className ? `mica-qr ${className}` : 'mica-qr'}
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${count + quiet * 2} ${count + quiet * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label || '二维码'}
    >
      <rect x={-quiet} y={-quiet} width={count + quiet * 2} height={count + quiet * 2} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
