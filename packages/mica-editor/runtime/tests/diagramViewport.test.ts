import { describe, expect, it } from 'vitest';

import {
  clampTransform,
  getDiagramLabel,
  getFitTransform,
  zoomTransform,
} from '../src/playground/plugins/MermaidPreviewPlugin/diagramViewport';
import type {
  DiagramSize,
  DiagramTransform,
  ViewportSize,
} from '../src/playground/plugins/MermaidPreviewPlugin/diagramViewport';

const diagram: DiagramSize = { width: 1000, height: 800 };
const viewport: ViewportSize = { width: 400, height: 300 };

function expectFinite(transform: DiagramTransform) {
  expect(Number.isFinite(transform.scale)).toBe(true);
  expect(Number.isFinite(transform.x)).toBe(true);
  expect(Number.isFinite(transform.y)).toBe(true);
}

describe('getFitTransform', () => {
  it('fits both dimensions with the default padding and centers the result', () => {
    const result = getFitTransform(diagram, viewport);
    expect(result.scale).toBeCloseTo(236 / 800);
    expect(result.x).toBeCloseTo((400 - 1000 * result.scale) / 2);
    expect(result.y).toBeCloseTo(32);
    expect(diagram.width * result.scale).toBeLessThanOrEqual(viewport.width - 64);
    expect(diagram.height * result.scale).toBeLessThanOrEqual(viewport.height - 64);
  });

  it('uses custom padding and the limiting width', () => {
    expect(getFitTransform({ width: 1000, height: 500 }, { width: 500, height: 400 }, 40)).toEqual({
      scale: 0.42,
      x: 40,
      y: 95,
    });
  });

  it('centers small diagrams without enlarging them', () => {
    expect(getFitTransform({ width: 100, height: 80 }, viewport)).toEqual({ scale: 1, x: 150, y: 110 });
  });

  it('can fit very large diagrams below the interactive zoom minimum', () => {
    const result = getFitTransform({ width: 10000, height: 10000 }, viewport);
    expect(result.scale).toBeCloseTo(0.0236);
    expect(10000 * result.scale).toBeLessThanOrEqual(236);
  });

  it.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    'normalizes invalid dimensions (%s) to at least one pixel',
    (value) => {
      expect(getFitTransform({ width: value, height: value }, viewport)).toEqual({ scale: 1, x: 199.5, y: 149.5 });
      expectFinite(getFitTransform(diagram, { width: value, height: value }));
    },
  );

  it('keeps tiny viewports and excessive padding finite', () => {
    const result = getFitTransform(diagram, { width: 1, height: 1 }, 1000);
    expectFinite(result);
    expect(result.scale).toBe(0.001);
    expect(getFitTransform(diagram, viewport, -10)).toEqual(getFitTransform(diagram, viewport, 0));
    expect(getFitTransform(diagram, viewport, Number.NaN)).toEqual(getFitTransform(diagram, viewport));
  });
});

describe('clampTransform', () => {
  it('preserves a fit below 10% when panning or resizing', () => {
    const large = { width: 10000, height: 10000 };
    const fit = getFitTransform(large, viewport);
    const moved = clampTransform({ ...fit, x: fit.x + 20, y: fit.y + 20 }, large, viewport);
    expect(moved.scale).toBe(fit.scale);
    expect(moved).toEqual(fit);
    expect(clampTransform(fit, large, { width: 420, height: 300 }).scale).toBe(fit.scale);
  });

  it('bounds large diagrams with a 32 pixel gutter on each edge', () => {
    expect(clampTransform({ scale: 1, x: 10000, y: 10000 }, diagram, viewport)).toEqual({ scale: 1, x: 32, y: 32 });
    expect(clampTransform({ scale: 1, x: -10000, y: -10000 }, diagram, viewport)).toEqual({
      scale: 1,
      x: -632,
      y: -532,
    });
  });

  it('preserves an in-bounds translation and does not mutate its input', () => {
    const original = Object.freeze({ scale: 1, x: -200, y: -100 });
    expect(clampTransform(original, diagram, viewport)).toEqual(original);
  });

  it('centers each small axis independently after applying scale', () => {
    expect(clampTransform({ scale: 0.5, x: 999, y: -999 }, diagram, viewport)).toEqual({ scale: 0.5, x: 32, y: -132 });
    expect(clampTransform({ scale: 1, x: -999, y: -999 }, { width: 1000, height: 80 }, viewport)).toEqual({
      scale: 1,
      x: -632,
      y: 110,
    });
    expect(clampTransform({ scale: 0.1, x: 999, y: -999 }, diagram, viewport)).toEqual({ scale: 0.1, x: 150, y: 110 });
  });

  it('centers dimensions that exactly match the viewport', () => {
    expect(clampTransform({ scale: 1, x: 12, y: -50 }, viewport, viewport)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('limits zoom to 0.1 through 4', () => {
    expect(clampTransform({ scale: -2, x: 0, y: 0 }, diagram, viewport).scale).toBe(0.1);
    expect(clampTransform({ scale: 10, x: 0, y: 0 }, diagram, viewport).scale).toBe(4);
  });

  it('repairs non-finite transforms and dimensions', () => {
    expect(clampTransform({ scale: Number.NaN, x: Infinity, y: Number.NaN }, diagram, viewport)).toEqual({
      scale: 1,
      x: -300,
      y: -250,
    });
    expectFinite(
      clampTransform(
        { scale: Infinity, x: Infinity, y: -Infinity },
        { width: Number.NaN, height: -5 },
        { width: 0, height: Infinity },
      ),
    );
  });

  it('keeps part of a large diagram visible even in a viewport smaller than the gutter', () => {
    const tinyViewport = { width: 10, height: 8 };
    for (const position of [-10000, 10000]) {
      const result = clampTransform({ scale: 1, x: position, y: position }, diagram, tinyViewport);
      expect(result.x).toBeLessThan(tinyViewport.width);
      expect(result.x + diagram.width).toBeGreaterThan(0);
      expect(result.y).toBeLessThan(tinyViewport.height);
      expect(result.y + diagram.height).toBeGreaterThan(0);
    }
  });
});

describe('zoomTransform', () => {
  it('zooms smoothly from a fit below 10% without jumping to the normal minimum', () => {
    const large = { width: 10000, height: 10000 };
    const fit = getFitTransform(large, viewport);
    const result = zoomTransform(fit, fit.scale * 1.25, { x: 200, y: 150 }, large, viewport);
    expect(result.scale).toBeCloseTo(fit.scale * 1.25);
    expect(zoomTransform(result, 0.001, { x: 200, y: 150 }, large, viewport).scale).toBe(fit.scale);
  });

  it.each([
    { x: 100, y: 80 },
    { x: 200, y: 150 },
  ])('keeps the original diagram point fixed at viewport origin %j', (origin) => {
    const previous = { scale: 1, x: -200, y: -150 };
    const result = zoomTransform(previous, 2, origin, diagram, viewport);
    expect((origin.x - result.x) / result.scale).toBeCloseTo((origin.x - previous.x) / previous.scale);
    expect((origin.y - result.y) / result.scale).toBeCloseTo((origin.y - previous.y) / previous.scale);
  });

  it('uses the bounded target scale when calculating the anchor', () => {
    const previous = { scale: 1, x: -200, y: -150 };
    const result = zoomTransform(previous, 20, { x: 200, y: 150 }, diagram, viewport);
    expect(result).toEqual({ scale: 4, x: -1400, y: -1050 });
  });

  it('centers small diagrams when zooming out, taking precedence over the anchor', () => {
    expect(zoomTransform({ scale: 1, x: -200, y: -150 }, 0.01, { x: 30, y: 40 }, diagram, viewport)).toEqual({
      scale: 0.1,
      x: 150,
      y: 110,
    });
  });

  it('clamps panning when an anchored zoom would move beyond an edge', () => {
    const result = zoomTransform({ scale: 2, x: 32, y: 32 }, 1, { x: 0, y: 0 }, diagram, viewport);
    expect(result).toEqual({ scale: 1, x: 16, y: 16 });
    expect(zoomTransform({ scale: 2, x: 32, y: 32 }, 4, { x: 0, y: 0 }, diagram, viewport)).toEqual({
      scale: 4,
      x: 32,
      y: 32,
    });
  });

  it('preserves a fitted point when the starting scale is below 0.1', () => {
    const largeDiagram = { width: 10000, height: 10000 };
    const fit = getFitTransform(largeDiagram, viewport);
    const origin = { x: 200, y: 150 };
    const result = zoomTransform(fit, 0.1, origin, largeDiagram, viewport);
    expect((origin.x - result.x) / result.scale).toBeCloseTo(5000);
    expect((origin.y - result.y) / result.scale).toBeCloseTo(5000);
  });

  it('handles invalid origins and transforms without producing NaN', () => {
    expectFinite(
      zoomTransform(
        { scale: 0, x: Infinity, y: Number.NaN },
        Number.NaN,
        { x: Number.NaN, y: Infinity },
        diagram,
        viewport,
      ),
    );
  });
});

describe('getDiagramLabel', () => {
  it.each([
    ['flowchart LR', '流程图'],
    ['graph TD;', '流程图'],
    ['sequenceDiagram\nAlice->>Bob: Hi', '时序图'],
    ['classDiagram', '类图'],
    ['stateDiagram-v2', '状态图'],
    ['stateDiagram', '状态图'],
    ['erDiagram', '实体关系图'],
    ['gantt', '甘特图'],
    ['pie showData', '饼图'],
    ['mindmap', '思维导图'],
    ['timeline', '时间线'],
    ['gitGraph:', 'Git 分支图'],
    ['journey', '用户旅程图'],
    ['xychart-beta', '坐标图'],
  ])('identifies %s', (source, expected) => {
    expect(getDiagramLabel(source)).toBe(expected);
  });

  it('skips whitespace, a BOM, CRLF, comments, and closed leading frontmatter', () => {
    expect(
      getDiagramLabel('\uFEFF\r\n %% comment\r\n---\r\ntitle: flowchart\r\n---\r\n%% another\r\n sequenceDiagram'),
    ).toBe('时序图');
    expect(getDiagramLabel('%% flowchart LR\n\n  graph TD')).toBe('流程图');
    expect(getDiagramLabel('%%{init: {"theme": "dark"}}%%\nflowchart LR')).toBe('流程图');
  });

  it.each([
    '',
    '   \n%% graph TD',
    'unknown\nflowchart LR',
    'flowchartish LR',
    'flowchart_v2 LR',
    '---\ntitle: test\nflowchart LR',
    'title: test\n---\nflowchart LR\n---',
    'constructor',
    'toString',
  ])('falls back for unsupported or incomplete declarations: %j', (source) => {
    expect(getDiagramLabel(source)).toBe('图表');
  });
});
