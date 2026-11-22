/**
 * Charts (TradingView lightweight-charts, Apache-2.0; the attribution logo stays on).
 * Colours are read from the CSS tokens so both themes work, and re-applied when the
 * system theme changes.
 */
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'preact/hooks';
import type { Kline } from '../data/binance.ts';
import type { MarkerView } from '../worker/viewModel.ts';

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

function baseOptions() {
  return {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: token('--surface') }, textColor: token('--muted'), fontFamily: token('--font'), fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: token('--line') }, horzLines: { color: token('--line') } },
    rightPriceScale: { borderColor: token('--line') },
    timeScale: { borderColor: token('--line'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
  };
}

/** Create a chart bound to a div, re-themed on colour-scheme changes. */
function useChart(build: (chart: IChartApi) => void, deps: unknown[]) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, baseOptions());
    chartRef.current = chart;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme = () => chart.applyOptions(baseOptions());
    mq?.addEventListener?.('change', onTheme);
    return () => {
      mq?.removeEventListener?.('change', onTheme);
      chart.remove();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (chartRef.current) build(chartRef.current);
  }, deps);
  return el;
}

export interface PriceLine {
  price: number;
  title: string;
  kind: 'zone' | 'target' | 'stop';
}

export function PriceChart(props: {
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[];
  markers: MarkerView[]; forming: Kline | null; lines: PriceLine[]; label: string;
}) {
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lastKey = useRef('');
  const el = useChart(
    (chart) => {
      const key = `${props.t[0]}:${props.t.length}:${props.lines.map((l) => l.price).join(',')}:${props.markers.length}`;
      if (!seriesRef.current) {
        seriesRef.current = chart.addSeries(CandlestickSeries, {
          upColor: token('--buy'), downColor: token('--sell'), wickUpColor: token('--buy'), wickDownColor: token('--sell'), borderVisible: false,
          priceLineVisible: true,
        });
      }
      const s = seriesRef.current;
      if (key !== lastKey.current) {
        lastKey.current = key;
        s.setData(props.t.map((t, i) => ({ time: sec(t), open: props.o[i], high: props.h[i], low: props.l[i], close: props.c[i] })));
        for (const pl of s.priceLines()) s.removePriceLine(pl);
        for (const ln of props.lines) {
          s.createPriceLine({
            price: ln.price, title: ln.title, lineWidth: ln.kind === 'target' ? 2 : 1,
            lineStyle: ln.kind === 'zone' ? LineStyle.Dashed : ln.kind === 'stop' ? LineStyle.Dotted : LineStyle.Solid,
            color: ln.kind === 'zone' ? token('--buy') : ln.kind === 'stop' ? token('--sell') : token('--accent'),
            axisLabelVisible: ln.kind !== 'zone',
          });
        }
        const ms: SeriesMarker<Time>[] = props.markers
          .map((m) => ({
            time: sec(m.time), position: m.side === 'buy' ? 'belowBar' : 'aboveBar', shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
            color: m.side === 'buy' ? token('--buy') : token('--sell'), text: m.text,
          }) as SeriesMarker<Time>)
          .sort((a, b) => (a.time as number) - (b.time as number));
        if (!markersRef.current) markersRef.current = createSeriesMarkers(s, ms);
        else markersRef.current.setMarkers(ms);
        chart.timeScale().fitContent();
      }
      const f = props.forming;
      if (f && props.t.length && f.t > props.t[props.t.length - 1]) {
        s.update({ time: sec(f.t), open: f.o, high: f.h, low: f.l, close: f.c });
      }
    },
    [props.t, props.markers, props.forming, props.lines],
  );
  return <div class="chart" ref={el} role="img" aria-label={props.label} />;
}

export interface LineDef {
  name: string;
  color: string;
  t: number[];
  v: number[];
  width?: number;
  dashed?: boolean;
}

export function LinesChart(props: { lines: LineDef[]; label: string; small?: boolean; precision?: number; area?: { t: number[]; lo: number[]; hi: number[]; color: string } }) {
  const seriesRefs = useRef<ISeriesApi<'Line' | 'Area'>[]>([]);
  const el = useChart(
    (chart) => {
      for (const s of seriesRefs.current) chart.removeSeries(s);
      seriesRefs.current = [];
      if (props.area) {
        const fmt = { type: 'price' as const, precision: props.precision ?? 0, minMove: props.precision ? 10 ** -props.precision : 1 };
        const hi = chart.addSeries(AreaSeries, { lineColor: 'transparent', topColor: props.area.color, bottomColor: props.area.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: fmt });
        hi.setData(props.area.t.map((t, i) => ({ time: sec(t), value: props.area!.hi[i] })));
        const lo = chart.addSeries(AreaSeries, { lineColor: 'transparent', topColor: token('--surface'), bottomColor: token('--surface'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: fmt });
        lo.setData(props.area.t.map((t, i) => ({ time: sec(t), value: props.area!.lo[i] })));
        seriesRefs.current.push(hi, lo);
      }
      for (const ln of props.lines) {
        const s = chart.addSeries(LineSeries, {
          color: ln.color, lineWidth: (ln.width ?? 2) as 1 | 2 | 3 | 4, lineStyle: ln.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: !ln.dashed, title: '',
          priceFormat: { type: 'price', precision: props.precision ?? 0, minMove: props.precision ? 10 ** -props.precision : 1 },
        });
        const seen = new Set<number>();
        const data = ln.t
          .map((t, i) => ({ time: sec(t), value: ln.v[i] }))
          .filter((p) => Number.isFinite(p.value) && !seen.has(p.time) && (seen.add(p.time), true));
        s.setData(data);
        seriesRefs.current.push(s);
      }
      chart.timeScale().fitContent();
    },
    [props.lines, props.area],
  );
  return <div class={props.small ? 'chart sm' : 'chart'} ref={el} role="img" aria-label={props.label} />;
}

export const SERIES_COLORS = ['var(--accent)', '#d9822b', '#2a9d8f', '#8e5bd6', '#7a8397'];
/** lightweight-charts needs concrete colours, not CSS variables. */
export function resolveColor(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  return m ? token(m[1]) : c;
}
