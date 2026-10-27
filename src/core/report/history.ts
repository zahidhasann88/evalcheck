import type { RunResult } from '../types.js';
import { mean, percentile } from '../utils/stats.js';
import { formatCost } from './console.js';

export interface HistoryPoint {
  runId: string;
  startedAt: string;
  passRate: number;
  cases: number;
  failed: number;
  latencyP95: number;
  tokensPerAttempt?: number;
  costPerAttempt?: number;
  tag?: string;
  commit?: string;
}

export interface HistorySeries {
  suiteName: string;
  variant?: string;
  points: HistoryPoint[];
}

export interface HistoryOptions {
  suite?: string;
  /** Keep only the most recent runs of every series. */
  limit?: number;
}

export function buildHistory(runs: RunResult[], options: HistoryOptions = {}): HistorySeries[] {
  const series = new Map<string, HistorySeries>();
  const seen = new Set<string>();
  for (const run of runs) {
    if (options.suite && run.meta.suiteName !== options.suite) continue;
    if (seen.has(run.meta.runId)) continue;
    seen.add(run.meta.runId);
    const key = `${run.meta.suiteName}\u0000${run.meta.variant ?? ''}`;
    const entry = series.get(key) ?? {
      suiteName: run.meta.suiteName,
      ...(run.meta.variant ? { variant: run.meta.variant } : {}),
      points: [],
    };
    entry.points.push(toPoint(run));
    series.set(key, entry);
  }
  return [...series.values()]
    .map((entry) => {
      const points = entry.points.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return { ...entry, points: options.limit ? points.slice(-options.limit) : points };
    })
    .sort((a, b) => label(a).localeCompare(label(b)));
}

function toPoint(run: RunResult): HistoryPoint {
  const attempts = run.cases.flatMap((c) => c.attempts);
  const tokens = attempts.map((a) => a.usage?.totalTokens).filter((v): v is number => v !== undefined);
  const costs = attempts.map((a) => a.usage?.cost).filter((v): v is number => v !== undefined);
  return {
    runId: run.meta.runId,
    startedAt: run.meta.startedAt,
    passRate: run.totals.passRate,
    cases: run.totals.cases,
    failed: run.totals.failed + run.totals.flaky + run.totals.errored,
    latencyP95: Math.round(percentile(attempts.map((a) => a.latencyMs), 95)),
    ...(tokens.length > 0 ? { tokensPerAttempt: Math.round(mean(tokens)) } : {}),
    ...(costs.length > 0 ? { costPerAttempt: mean(costs) } : {}),
    ...(run.meta.tag ? { tag: run.meta.tag } : {}),
    ...(run.meta.git?.commit ? { commit: run.meta.git.commit.slice(0, 7) } : {}),
  };
}

function label(series: HistorySeries): string {
  return series.variant ? `${series.suiteName} (${series.variant})` : series.suiteName;
}

function table(series: HistorySeries): { header: string[]; rows: string[][] } {
  const withTokens = series.points.some((p) => p.tokensPerAttempt !== undefined);
  const withCost = series.points.some((p) => p.costPerAttempt !== undefined);
  const header = ['date', 'pass rate', 'failed', 'p95', ...(withTokens ? ['tokens'] : []), ...(withCost ? ['cost'] : []), 'run'];
  const rows = series.points.map((point) => [
    point.startedAt.slice(0, 16).replace('T', ' '),
    `${(point.passRate * 100).toFixed(1)}%`,
    `${point.failed}/${point.cases}`,
    `${point.latencyP95}ms`,
    ...(withTokens ? [point.tokensPerAttempt !== undefined ? String(point.tokensPerAttempt) : '—'] : []),
    ...(withCost ? [point.costPerAttempt !== undefined ? formatCost(point.costPerAttempt) : '—'] : []),
    [point.tag, point.commit].filter(Boolean).join(' ') || point.runId,
  ]);
  return { header, rows };
}

/** One line describing how the first and the last run of a series differ. */
export function trendSummary(series: HistorySeries): string {
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  if (!first || !last || series.points.length < 2) return `${series.points.length} run`;
  const parts = [
    `pass rate ${(first.passRate * 100).toFixed(1)}% → ${(last.passRate * 100).toFixed(1)}%`,
    `p95 ${first.latencyP95}ms → ${last.latencyP95}ms`,
  ];
  if (first.tokensPerAttempt !== undefined && last.tokensPerAttempt !== undefined) {
    parts.push(`tokens ${first.tokensPerAttempt} → ${last.tokensPerAttempt}`);
  }
  return `${series.points.length} runs: ${parts.join(', ')}`;
}

export function historyToConsole(allSeries: HistorySeries[]): string {
  if (allSeries.length === 0) return 'no runs found\n';
  const lines: string[] = [];
  for (const series of allSeries) {
    const { header, rows } = table(series);
    const widths = header.map((_, index) => Math.max(...[header, ...rows].map((row) => row[index]!.length)));
    const format = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index]!)).join('   ').trimEnd();
    lines.push('', `history · ${label(series)}`, format(header), ...rows.map(format), trendSummary(series));
  }
  lines.push('');
  return lines.join('\n');
}

export function historyToMarkdown(allSeries: HistorySeries[]): string {
  const lines: string[] = [];
  for (const series of allSeries) {
    const { header, rows } = table(series);
    lines.push(
      `### History · ${label(series)}`,
      '',
      `| ${header.join(' | ')} |`,
      `| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
      '',
      trendSummary(series),
      '',
    );
  }
  return lines.join('\n');
}

export function historyToHtml(allSeries: HistorySeries[]): string {
  const sections = allSeries
    .map((series) => {
      const charts = [
        chart('Pass rate', series.points.map((p) => p.passRate * 100), (v) => `${v.toFixed(1)}%`, [0, 100]),
        chart('Latency p95', series.points.map((p) => p.latencyP95), (v) => `${Math.round(v)}ms`),
        ...(series.points.every((p) => p.tokensPerAttempt !== undefined)
          ? [chart('Tokens per attempt', series.points.map((p) => p.tokensPerAttempt!), (v) => String(Math.round(v)))]
          : []),
      ];
      const { header, rows } = table(series);
      return `<section>
  <h2>${escapeHtml(label(series))}</h2>
  <p class="muted">${escapeHtml(trendSummary(series))}</p>
  <div class="charts">${charts.join('\n')}</div>
  <table><thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n')}</tbody></table>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>evalcheck history</title>
<style>
  :root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #0969da; --grid: #d0d7de; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #4493f8; --grid: #30363d; }
  }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  section { margin-bottom: 40px; }
  .muted { color: var(--muted); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  figure { margin: 0; }
  figcaption { font-weight: 600; margin-bottom: 4px; }
  svg { width: 100%; height: auto; }
  svg .grid { stroke: var(--grid); }
  svg .axis { fill: var(--muted); font-size: 11px; }
  svg polyline { fill: none; stroke: var(--line); stroke-width: 2; }
  svg circle { fill: var(--line); }
  table { border-collapse: collapse; margin-top: 16px; width: 100%; overflow-x: auto; display: block; }
  th, td { text-align: right; padding: 4px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
</style>
</head>
<body>
<main>
<h1>evalcheck history</h1>
${allSeries.length === 0 ? '<p class="muted">No runs found.</p>' : sections}
</main>
</body>
</html>
`;
}

function chart(title: string, values: number[], format: (v: number) => string, range?: [number, number]): string {
  const width = 320;
  const height = 140;
  const pad = { left: 44, right: 10, top: 10, bottom: 20 };
  const min = range ? range[0] : Math.min(...values);
  const max = range ? range[1] : Math.max(...values);
  const span = max - min || 1;
  const x = (i: number): number =>
    values.length === 1 ? (pad.left + width - pad.right) / 2 : pad.left + (i / (values.length - 1)) * (width - pad.left - pad.right);
  const y = (v: number): number => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = values
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${escapeHtml(format(v))}</title></circle>`)
    .join('');
  return `<figure><figcaption>${escapeHtml(title)}</figcaption>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(max)}" y2="${y(max)}"/>
<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(min)}" y2="${y(min)}"/>
<text class="axis" x="${pad.left - 6}" y="${y(max) + 4}" text-anchor="end">${escapeHtml(format(max))}</text>
<text class="axis" x="${pad.left - 6}" y="${y(min) + 4}" text-anchor="end">${escapeHtml(format(min))}</text>
<polyline points="${points}"/>${dots}
</svg></figure>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
