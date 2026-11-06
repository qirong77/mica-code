import { useEffect, useMemo, useRef } from 'react';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ProcessDetail, TrendPoint } from '../shared/types';
import { clock, dateTime, escapeHtml, number, timestampMs } from './format';

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const colors = {
  cyan: '#64d9e8',
  green: '#a4e6af',
  purple: '#b6a2ef',
  amber: '#e5bf79',
  blue: '#7baff2',
  muted: '#718692',
};
const base = {
  animation: false,
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#8c9ca9' },
  tooltip: {
    trigger: 'axis',
    confine: true,
    backgroundColor: '#172128',
    borderColor: '#34434b',
    textStyle: { color: '#e7f0f4', fontSize: 12 },
    extraCssText: 'box-shadow:0 8px 36px #0006;border-radius:10px;',
  },
};
const axisStyle = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: '#718390', fontSize: 10 },
  splitLine: { lineStyle: { color: '#223039', type: 'dashed' } },
};

function Chart({ option, className, label }: { option: EChartsCoreOption; className: string; label: string }) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  useEffect(() => {
    if (!element.current) return;
    const instance = init(element.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { replaceMerge: ['series', 'graphic'] });
  }, [option]);
  return <div ref={element} className={className} role="img" aria-label={label} />;
}

function pointData(history: TrendPoint[], field: keyof TrendPoint, divisor = 1) {
  return history.flatMap((point) => {
    const ts = timestampMs(point.ts);
    const value = point[field];
    const entry = [ts, typeof value === 'number' && Number.isFinite(value) ? value / divisor : null];
    return point.gap || point.reboot ? [[ts - 1, null], entry] : [entry];
  });
}

export function TimelineChart({ history }: { history: TrendPoint[] }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const line = (name: string, field: keyof TrendPoint, axis: number, color: string, divisor = 1, yAxis = axis) => ({
      name,
      type: 'line',
      xAxisIndex: axis,
      yAxisIndex: yAxis,
      data: pointData(history, field, divisor),
      showSymbol: history.length <= 1,
      symbolSize: 5,
      connectNulls: false,
      smooth: false,
      lineStyle: { width: 1.7, color },
      itemStyle: { color },
      emphasis: { focus: 'series' },
    });
    const reboots = history
      .filter((point) => point.reboot)
      .map((point) => ({
        name: '重启',
        xAxis: timestampMs(point.ts),
        label: { formatter: '重启', position: 'insideEndTop', color: colors.amber, fontSize: 10 },
      }));
    const gaps = history.flatMap((point, index) =>
      point.gap && index > 0 ? [[{ xAxis: timestampMs(history[index - 1].ts) }, { xAxis: timestampMs(point.ts) }]] : [],
    );
    const panels = [
      { top: 37, height: 142 },
      { top: 228, height: 79 },
      { top: 355, height: 85 },
      { top: 487, height: 66 },
    ];
    const min = history.length ? timestampMs(history[0].ts) : undefined;
    const max = history.length ? timestampMs(history[history.length - 1].ts) : undefined;
    const spansDays = min != null && max != null && max - min >= 86_400_000;
    return {
      ...base,
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: '#71939e', type: 'dashed' } },
      grid: panels.map((panel) => ({ left: 45, right: 44, ...panel })),
      xAxis: panels.map((_, index) => ({
        ...axisStyle,
        type: 'time',
        gridIndex: index,
        min: min === max && min != null ? min - 60000 : min,
        max: min === max && max != null ? max + 60000 : max,
        splitLine: { show: false },
        axisLabel: {
          ...axisStyle.axisLabel,
          show: index === 3,
          formatter: (value: number) => (spansDays ? dateTime(value, true) : clock(value)),
          hideOverlap: true,
        },
        axisPointer: {
          label: { formatter: (param: { value: number }) => dateTime(param.value), backgroundColor: '#34454e' },
        },
      })),
      yAxis: [
        { ...axisStyle, type: 'value', gridIndex: 0, min: 0, splitNumber: 3 },
        { ...axisStyle, type: 'value', gridIndex: 1, min: 0, splitNumber: 2 },
        { ...axisStyle, type: 'value', gridIndex: 2, min: 0, splitNumber: 2 },
        {
          ...axisStyle,
          type: 'value',
          gridIndex: 3,
          min: 0,
          max: 100,
          splitNumber: 1,
          axisLabel: { ...axisStyle.axisLabel, formatter: '{value}%' },
        },
        {
          ...axisStyle,
          type: 'value',
          gridIndex: 2,
          min: 0,
          splitNumber: 2,
          position: 'right',
          splitLine: { show: false },
          axisLabel: { ...axisStyle.axisLabel, color: colors.amber },
        },
      ],
      graphic: [
        { type: 'text', left: 0, top: 8, style: { text: '内存  /  GB', fill: '#b5c3cb', fontSize: 11 } },
        { type: 'text', left: 0, top: 199, style: { text: 'SWAP I/O  /  MB/s', fill: '#b5c3cb', fontSize: 11 } },
        { type: 'text', left: 0, top: 326, style: { text: '磁盘  /  MB/s', fill: '#b5c3cb', fontSize: 11 } },
        { type: 'text', right: 0, top: 326, style: { text: '负载  /  1 min', fill: colors.amber, fontSize: 11 } },
        { type: 'text', left: 0, top: 458, style: { text: 'CPU / GPU  /  %', fill: '#b5c3cb', fontSize: 11 } },
        ...(!history.some((point) => point.gpuPct != null)
          ? [
              {
                type: 'text',
                left: 'center',
                top: 511,
                style: { text: 'GPU 数据尚未采集', fill: '#677c89', fontSize: 11 },
              },
            ]
          : []),
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2, 3], filterMode: 'none', zoomOnMouseWheel: 'ctrl' },
        {
          type: 'slider',
          xAxisIndex: [0, 1, 2, 3],
          bottom: 1,
          height: 18,
          borderColor: '#28363f',
          backgroundColor: '#10191f',
          fillerColor: '#64d9e815',
          handleStyle: { color: '#5c8896', borderWidth: 0 },
          textStyle: { color: '#8d9ba5' },
          dataBackground: { lineStyle: { color: '#466270' }, areaStyle: { color: '#273c48' } },
        },
      ],
      tooltip: {
        ...base.tooltip,
        formatter: (
          params: { seriesName: string; value: [number, number | null]; color: string; axisValue: number }[],
        ) => {
          if (!Array.isArray(params) || !params.length) return '';
          const rows = params
            .filter((param) => param.value?.[1] != null)
            .map((param) => {
              const unit = ['Swap 已用', '压缩内存', '空闲内存', 'Wired'].includes(param.seriesName)
                ? ' GB'
                : ['换入', '换出', '磁盘吞吐'].includes(param.seriesName)
                  ? ' MB/s'
                  : ['GPU', '主机 CPU'].includes(param.seriesName)
                    ? '%'
                    : '';
              return `<div style="display:flex;gap:20px;justify-content:space-between;margin-top:5px"><span><span style="color:${escapeHtml(String(param.color))}">●</span> ${escapeHtml(param.seriesName)}</span><b>${number(param.value[1], 2)}${unit}</b></div>`;
            });
          return `<div style="color:#8ca5b2;margin-bottom:8px">${dateTime(params[0].axisValue)}</div>${rows.join('') || '该时刻无有效读数'}`;
        },
      },
      series: [
        {
          ...line('Swap 已用', 'swapMb', 0, colors.purple, 1024),
          areaStyle: { color: '#b6a2ef', opacity: 0.035 },
          markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: colors.amber }, data: reboots },
          markArea: { silent: true, itemStyle: { color: '#e5bf7910' }, data: gaps },
        },
        line('压缩内存', 'compressorMb', 0, colors.blue, 1024),
        line('空闲内存', 'freeMb', 0, colors.green, 1024),
        line('Wired', 'wiredMb', 0, colors.muted, 1024),
        line('换入', 'swapIn', 1, colors.cyan),
        line('换出', 'swapOut', 1, colors.purple),
        line('磁盘吞吐', 'diskMBs', 2, colors.cyan),
        line('1 分钟负载', 'load', 2, colors.amber, 1, 4),
        line('GPU', 'gpuPct', 3, colors.green),
        line('主机 CPU', 'hostCpuPct', 3, colors.cyan),
      ],
    };
  }, [history]);
  return (
    <Chart
      option={option}
      className="timeline-chart"
      label="历史趋势：内存、Swap 换入换出、磁盘吞吐、系统负载与 GPU。虚线标记重启，阴影标记采样间断。"
    />
  );
}

export function ProcessHistoryChart({ history }: { history: ProcessDetail['history'] }) {
  const option = useMemo<EChartsCoreOption>(
    () => ({
      ...base,
      grid: { left: 48, right: 47, top: 35, bottom: 34 },
      legend: { top: 0, textStyle: { color: '#9baeb8', fontSize: 11 }, itemWidth: 13, itemHeight: 3 },
      xAxis: {
        ...axisStyle,
        type: 'time',
        splitLine: { show: false },
        axisLabel: { ...axisStyle.axisLabel, formatter: (value: number) => clock(value), hideOverlap: true },
      },
      yAxis: [
        { ...axisStyle, type: 'value', name: 'MB', nameTextStyle: { color: '#718390' }, min: 0, splitNumber: 3 },
        {
          ...axisStyle,
          type: 'value',
          name: 'CPU %',
          nameTextStyle: { color: '#718390' },
          min: 0,
          splitNumber: 3,
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Footprint',
          type: 'line',
          showSymbol: history.length === 1,
          connectNulls: false,
          lineStyle: { width: 2 },
          itemStyle: { color: colors.cyan },
          areaStyle: { opacity: 0.06 },
          data: history.map((point) => [timestampMs(point.ts), point.fp]),
        },
        {
          name: 'RSS',
          type: 'line',
          showSymbol: history.length === 1,
          connectNulls: false,
          lineStyle: { width: 1.5 },
          itemStyle: { color: colors.purple },
          data: history.map((point) => [timestampMs(point.ts), point.rss]),
        },
        {
          name: 'CPU',
          type: 'line',
          showSymbol: history.length === 1,
          connectNulls: false,
          yAxisIndex: 1,
          lineStyle: { width: 1.5 },
          itemStyle: { color: colors.amber },
          data: history.map((point) => [timestampMs(point.ts), point.cpu]),
        },
      ],
    }),
    [history],
  );
  return <Chart option={option} className="process-history-chart" label="该进程实例的 Footprint、RSS 与 CPU 历史" />;
}
