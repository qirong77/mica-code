// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';

import {tableScrollEdges, visibleTableViewport} from '../src/playground/plugins/TableScrollShadowPlugin/scrollGeometry';

function rect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
  Object.defineProperties(element, {
    clientWidth: {configurable: true, value: width},
    clientHeight: {configurable: true, value: height},
  });
}

afterEach(() => {document.body.replaceChildren();});

describe('table overflow fades', () => {
  it('only shows the edge with more content, and removes both when the table fits', () => {
    const element = {scrollWidth: 900, clientWidth: 500, scrollLeft: 0};
    expect(tableScrollEdges(element)).toEqual({hasLeft: false, hasRight: true});
    expect(tableScrollEdges({...element, scrollLeft: 120})).toEqual({hasLeft: true, hasRight: true});
    expect(tableScrollEdges({...element, scrollLeft: 400})).toEqual({hasLeft: true, hasRight: false});
    expect(tableScrollEdges({...element, clientWidth: 900})).toEqual({hasLeft: false, hasRight: false});
  });

  it('does not leave a fade on the rounded final pixel', () => {
    expect(tableScrollEdges({scrollWidth: 901, clientWidth: 500, scrollLeft: 400.5}))
      .toEqual({hasLeft: true, hasRight: false});
  });

  it('clips over the whole visible table including an opaque header, but excludes the scrollbar', () => {
    Object.defineProperties(document.documentElement, {
      clientWidth: {configurable: true, value: 1000},
      clientHeight: {configurable: true, value: 700},
    });
    const editor = document.createElement('div');
    editor.style.overflowY = 'auto';
    rect(editor, 100, 80, 600, 400);
    const wrapper = document.createElement('div');
    wrapper.style.overflowX = 'auto';
    rect(wrapper, 120, 140, 500, 260);
    const table = document.createElement('table');
    table.innerHTML = '<tr><th style="background:#fff">标题</th></tr><tr><td>正文</td></tr>';
    rect(table, 120, 140, 900, 240);
    wrapper.append(table);
    editor.append(wrapper);
    document.body.append(editor);
    expect(visibleTableViewport(wrapper)).toEqual({left: 120, right: 620, top: 140, bottom: 380});
    // Both axes still obey the outer editor's clip after scrolling.
    rect(wrapper, 120, 40, 500, 500);
    rect(table, -80, 40, 900, 500);
    expect(visibleTableViewport(wrapper)).toEqual({left: 120, right: 620, top: 80, bottom: 480});
  });

  it('does not render orphaned or fully clipped tables', () => {
    const wrapper = document.createElement('div');
    expect(visibleTableViewport(wrapper)).toBeNull();
    wrapper.innerHTML = '<table></table>';
    document.body.append(wrapper);
    rect(wrapper.firstElementChild as HTMLElement, 0, 800, 900, 120);
    expect(visibleTableViewport(wrapper)).toBeNull();
  });
});
