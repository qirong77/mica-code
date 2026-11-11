export interface DiagramSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface DiagramTransform {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const PAN_PADDING = 32;

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function scaleWithinBounds(value: number, minimum = MIN_SCALE): number {
  return Number.isFinite(value) ? Math.min(MAX_SCALE, Math.max(minimum, value)) : 1;
}

/** Fit the whole diagram without enlarging it. Coordinates are viewport pixels. */
export function getFitTransform(diagram: DiagramSize, viewport: ViewportSize, padding = 32): DiagramTransform {
  const width = dimension(diagram.width);
  const height = dimension(diagram.height);
  const viewportWidth = dimension(viewport.width);
  const viewportHeight = dimension(viewport.height);
  const inset = Number.isFinite(padding) ? Math.max(0, padding) : 32;
  const scale = Math.min(
    1,
    Math.max(1, viewportWidth - inset * 2) / width,
    Math.max(1, viewportHeight - inset * 2) / height,
  );

  return {
    scale,
    x: (viewportWidth - width * scale) / 2,
    y: (viewportHeight - height * scale) / 2,
  };
}

function clampAxis(position: number, extent: number, viewportExtent: number): number {
  const center = (viewportExtent - extent) / 2;
  if (extent <= viewportExtent) return center;

  // Allow a small gutter at either end of a large diagram, but no empty panning.
  const gutter = Math.min(PAN_PADDING, viewportExtent / 2);
  const finitePosition = Number.isFinite(position) ? position : center;
  return Math.min(gutter, Math.max(viewportExtent - extent - gutter, finitePosition));
}

/** Keep small diagrams centered and large diagrams within their pan boundaries. */
export function clampTransform(
  transform: DiagramTransform,
  diagram: DiagramSize,
  viewport: ViewportSize,
): DiagramTransform {
  // Panning must preserve a legitimate fit below 10%. Only explicit zoom
  // operations decide the minimum scale; moving a large graph never zooms it.
  const scale =
    transform.scale > 0 && transform.scale < MIN_SCALE ? transform.scale : scaleWithinBounds(transform.scale);
  return {
    scale,
    x: clampAxis(transform.x, dimension(diagram.width) * scale, dimension(viewport.width)),
    y: clampAxis(transform.y, dimension(diagram.height) * scale, dimension(viewport.height)),
  };
}

/** Zoom around a viewport point; centering and pan boundaries take precedence. */
export function zoomTransform(
  transform: DiagramTransform,
  nextScale: number,
  origin: { x: number; y: number },
  diagram: DiagramSize,
  viewport: ViewportSize,
): DiagramTransform {
  const minimum = Math.min(MIN_SCALE, getFitTransform(diagram, viewport).scale);
  const scale = scaleWithinBounds(nextScale, minimum);
  // Fit can legitimately produce a scale below MIN_SCALE for a very large graph.
  const previousScale = Number.isFinite(transform.scale) && transform.scale > 0 ? transform.scale : 1;
  const originX = Number.isFinite(origin.x) ? origin.x : dimension(viewport.width) / 2;
  const originY = Number.isFinite(origin.y) ? origin.y : dimension(viewport.height) / 2;
  const previousX = Number.isFinite(transform.x) ? transform.x : 0;
  const previousY = Number.isFinite(transform.y) ? transform.y : 0;
  const ratio = scale / previousScale;

  return clampTransform(
    {
      scale,
      x: originX - (originX - previousX) * ratio,
      y: originY - (originY - previousY) * ratio,
    },
    diagram,
    viewport,
  );
}

const DIAGRAM_LABELS: Readonly<Record<string, string>> = {
  flowchart: '流程图',
  graph: '流程图',
  sequenceDiagram: '时序图',
  classDiagram: '类图',
  stateDiagram: '状态图',
  erDiagram: '实体关系图',
  gantt: '甘特图',
  pie: '饼图',
  mindmap: '思维导图',
  timeline: '时间线',
  gitGraph: 'Git 分支图',
  journey: '用户旅程图',
  quadrantChart: '象限图',
  requirementDiagram: '需求图',
  sankey: '桑基图',
  xychart: '坐标图',
  block: '块图',
  packet: '数据包图',
  architecture: '架构图',
};

/** Read the declaration only, ignoring leading comments and closed frontmatter. */
export function getDiagramLabel(source: string): string {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let index = 0;
  const skipComments = () => {
    while (index < lines.length && /^(?:\s*|\s*%%.*)$/.test(lines[index])) index += 1;
  };

  skipComments();
  if (lines[index]?.trim() === '---') {
    index += 1;
    while (index < lines.length && lines[index].trim() !== '---') index += 1;
    if (index === lines.length) return '图表';
    index += 1;
    skipComments();
  }

  const declaration = lines[index]?.trim().match(/^([A-Za-z]+)(?:-v\d+|-beta)?(?=\s|$|;|:)/);
  const type = declaration?.[1];
  return type && Object.prototype.hasOwnProperty.call(DIAGRAM_LABELS, type) ? DIAGRAM_LABELS[type] : '图表';
}
