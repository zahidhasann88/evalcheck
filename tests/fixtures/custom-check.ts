/** TypeScript custom check used by the test suite. */
interface Verdict {
  pass: boolean;
  score?: number;
  reason?: string;
}

export default function notTooLong(response: { text: string }): Verdict {
  const length = response.text.length;
  return {
    pass: length <= 100,
    score: length <= 100 ? 1 : 0,
    reason: `response length is ${length}`,
  };
}
