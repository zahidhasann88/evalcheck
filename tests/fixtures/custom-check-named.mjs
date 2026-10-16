/**
 * Custom check that returns a named export.
 */
export function noShouting(response) {
  const shouted = /[A-Z]{5,}/.test(response.text);
  return {
    pass: !shouted,
    reason: shouted ? 'response contains SHOUTING' : 'response is calm',
  };
}
