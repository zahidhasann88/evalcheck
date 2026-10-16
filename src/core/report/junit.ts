// Flaky cases are reported as failures, with the pass rate in the message.

import type { RunResult } from '../types.js';

export function reportToJunit(result: RunResult): string {
  const cases = result.cases;
  const failures = cases.filter((c) => c.status === 'failed' || c.status === 'error' || c.status === 'flaky');
  const skipped = cases.filter((c) => c.status === 'skipped');
  const durationSeconds = result.meta.durationMs / 1000;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="${escapeXml(result.meta.suiteName)}" tests="${cases.length}" failures="${failures.length}" errors="0" skipped="${skipped.length}" time="${durationSeconds.toFixed(3)}">`,
  );
  lines.push(
    `  <testsuite name="${escapeXml(result.meta.suiteName)}" tests="${cases.length}" failures="${failures.length}" errors="0" skipped="${skipped.length}" time="${durationSeconds.toFixed(3)}" timestamp="${escapeXml(result.meta.startedAt)}">`,
  );
  lines.push('    <properties>');
  lines.push(`      <property name="suiteHash" value="${escapeXml(result.meta.suiteHash)}"/>`);
  lines.push(`      <property name="runId" value="${escapeXml(result.meta.runId)}"/>`);
  lines.push(`      <property name="schemaVersion" value="${escapeXml(result.schemaVersion)}"/>`);
  if (result.meta.tag) {
    lines.push(`      <property name="tag" value="${escapeXml(result.meta.tag)}"/>`);
  }
  lines.push('    </properties>');

  for (const caseResult of cases) {
    const time = (caseResult.durationMs / 1000).toFixed(3);
    const classname = escapeXml(result.meta.suiteName);
    const name = escapeXml(caseResult.id);
    const isFailure = caseResult.status === 'failed' || caseResult.status === 'error' || caseResult.status === 'flaky';

    lines.push(`    <testcase classname="${classname}" name="${name}" time="${time}">`);

    if (caseResult.status === 'skipped') {
      lines.push('      <skipped/>');
    } else if (isFailure) {
      const message = failureMessage(caseResult);
      lines.push(`      <failure message="${escapeXml(message)}" type="${escapeXml(caseResult.status)}">`);
      lines.push(escapeXml(detailBody(caseResult)));
      lines.push('      </failure>');
    }

    if (caseResult.attempts.length > 0) {
      lines.push('      <system-out>');
      lines.push(escapeXml(systemOut(caseResult)));
      lines.push('      </system-out>');
    }

    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

function failureMessage(caseResult: RunResult['cases'][number]): string {
  if (caseResult.status === 'flaky') {
    const passed = Math.round(caseResult.passRate * caseResult.repeat);
    return `flaky: ${passed}/${caseResult.repeat} repeats passed`;
  }
  const failing = caseResult.checks.filter((c) => c.passRate < 1);
  if (failing.length > 0) {
    return failing.map((c) => `${c.id} (${c.type})`).join(', ');
  }
  return caseResult.error ?? 'case failed';
}

function detailBody(caseResult: RunResult['cases'][number]): string {
  const lines: string[] = [];
  for (const check of caseResult.checks) {
    if (check.passRate >= 1) continue;
    lines.push(`check ${check.id} (${check.type}): ${check.passCount}/${check.total} passed`);
    for (const reason of check.reasons) lines.push(`  - ${reason}`);
  }
  if (caseResult.error) lines.push(`request error: ${caseResult.error}`);
  if (lines.length === 0) lines.push('no failing check details available');
  return lines.join('\n');
}

function systemOut(caseResult: RunResult['cases'][number]): string {
  const lines: string[] = [];
  lines.push(`latency p50 ${caseResult.latencyMs.p50}ms, p95 ${caseResult.latencyMs.p95}ms`);
  for (const attempt of caseResult.attempts) {
    lines.push(
      `attempt ${attempt.index + 1}: status ${attempt.status ?? 'n/a'}, ${Math.round(attempt.latencyMs)}ms${
        attempt.ttftMs !== undefined ? `, ttft ${Math.round(attempt.ttftMs)}ms` : ''
      }`,
    );
    lines.push(`  response: ${truncate(attempt.text.replace(/\s+/g, ' '), 2000)}`);
  }
  return lines.join('\n');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip characters that are illegal in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
