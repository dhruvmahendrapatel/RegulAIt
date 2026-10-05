/**
 * ADR-0173 batch 2c (K) — one series chart on recharts (MIT). Lazy-loaded by
 * MonitoringPage so recharts stays out of the main bundle. Series colours are
 * the validated categorical slots in monitoring.module.css (`.palette`, set
 * on the enclosing figure), each with its own dash pattern (`SERIES_DASHES`,
 * drawn in the legend too) so colour is never the only cue; axes, grid and
 * tooltip use theme tokens. The
 * keyboard layer is off: the data table under every chart is the accessible
 * reading of the same values.
 */
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES_DASHES, bucketLabel, formatMetricValue } from "./monitoringModel";

const SERIES_VARS = ["--mon-s1", "--mon-s2", "--mon-s3", "--mon-s4", "--mon-s5", "--mon-s6"];

export default function SeriesLineChart(props: {
  rows: Array<Record<string, string | number | null>>;
  charted: Array<{ key: string; label: string }>;
  metric: string;
  bucket: "hour" | "day";
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={props.rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }} accessibilityLayer={false}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={(b: string) => bucketLabel(b, props.bucket)} stroke="var(--text-dim)" fontSize={12} />
        <YAxis stroke="var(--text-dim)" fontSize={12} width={56} tickFormatter={(n: number) => formatMetricValue(props.metric, n)} />
        <Tooltip
          formatter={(value) => formatMetricValue(props.metric, typeof value === "number" ? value : null)}
          labelFormatter={(b) => String(b)}
          contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text)" }}
        />
        {props.charted.length > 1 && <Legend wrapperStyle={{ color: "var(--text)", fontSize: 12 }} />}
        {props.charted.map((g, i) => (
          <Line
            key={g.key}
            type="linear"
            dataKey={g.key}
            name={g.label}
            stroke={`var(${SERIES_VARS[i]})`}
            strokeDasharray={SERIES_DASHES[i] || undefined}
            legendType="plainline"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
