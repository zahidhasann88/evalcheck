/** Example custom check used by the test suite. */
export default function containsQuestionMark(response, ctx) {
  const text = response.text || '';
  const pass = text.includes('?') || text.includes('।');
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? 'response looks like a question or a sentence'
      : `case ${ctx.case.id} produced a very short answer`,
  };
}
