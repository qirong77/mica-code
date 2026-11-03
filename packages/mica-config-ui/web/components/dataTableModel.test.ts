import { describe, expect, test } from 'vitest';
import { pageRangeLabel, pageWindow } from './dataTableModel.js';

describe('pageWindow', () => {
  test('常规切页给出本页区间', () => {
    expect(pageWindow(137, 0, 20)).toEqual({
      page: 0,
      pageCount: 7,
      start: 0,
      end: 20,
      total: 137,
      pageSize: 20,
    });
    const last = pageWindow(137, 6, 20);
    expect(last).toMatchObject({ page: 6, start: 120, end: 137 });
  });

  test('页码越界时夹到最后一页，而不是画一张空表', () => {
    expect(pageWindow(30, 9, 20)).toMatchObject({ page: 1, start: 20, end: 30 });
    expect(pageWindow(30, -3, 20)).toMatchObject({ page: 0 });
  });

  test('行数变少后越界的页码跟着收敛', () => {
    expect(pageWindow(5, 4, 20)).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 5 });
  });

  test('不分页时全部行算一页', () => {
    expect(pageWindow(37, 3, 0)).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 37 });
    expect(pageWindow(0, 0, 20)).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 0 });
  });
});

describe('pageRangeLabel', () => {
  test('给出 1 起的闭区间与总数', () => {
    expect(pageRangeLabel(pageWindow(137, 0, 20))).toBe('1–20 / 137');
    expect(pageRangeLabel(pageWindow(137, 6, 20))).toBe('121–137 / 137');
    expect(pageRangeLabel(pageWindow(0, 0, 20))).toBe('0');
  });
});
