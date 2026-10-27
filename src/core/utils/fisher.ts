/**
 * One-sided Fisher exact test for a 2x2 table of passes and fails in run A and run B.
 * Returns the probability of seeing B's pass count, or fewer, if both runs had the same
 * underlying pass rate.
 */
export function fisherLowerTail(passA: number, failA: number, passB: number, failB: number): number {
  const n = passA + failA + passB + failB;
  const rowA = passA + failA;
  const passes = passA + passB;
  const rowB = passB + failB;
  const minB = Math.max(0, passes - rowA);
  let p = 0;
  for (let k = minB; k <= passB; k++) {
    p += Math.exp(logChoose(rowB, k) + logChoose(rowA, passes - k) - logChoose(n, passes));
  }
  return Math.min(1, p);
}

/** Smallest p-value a case with these repeat counts can reach (all passes versus all fails). */
export function minimumPValue(attemptsA: number, attemptsB: number): number {
  return fisherLowerTail(attemptsA, 0, 0, attemptsB);
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const cache: number[] = [0];

function logFactorial(n: number): number {
  for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1]! + Math.log(i);
  return cache[n]!;
}
