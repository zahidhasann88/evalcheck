export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;

  let searchFrom = 0;
  for (;;) {
    const lf = rest.indexOf('\n\n', searchFrom);
    const crlf = rest.indexOf('\r\n\r\n', searchFrom);
    let index = -1;
    let size = 0;
    if (lf !== -1 && (crlf === -1 || lf < crlf)) {
      index = lf;
      size = 2;
    } else if (crlf !== -1) {
      index = crlf;
      size = 4;
    } else {
      break;
    }
    const frame = rest.slice(0, index);
    rest = rest.slice(index + size);
    const parsed = parseFrame(frame);
    if (parsed) events.push(parsed);
    searchFrom = 0;
  }

  return { events, rest };
}

function parseFrame(frame: string): SseEvent | undefined {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      default:
        break;
    }
  }

  if (dataLines.length === 0) return undefined;
  return { data: dataLines.join('\n'), ...(event ? { event } : {}), ...(id ? { id } : {}) };
}

/** True for the OpenAI style terminator event. */
export function isDoneEvent(event: SseEvent): boolean {
  return event.data.trim() === '[DONE]';
}
