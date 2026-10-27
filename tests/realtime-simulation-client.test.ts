import { describe, expect, it } from 'vitest';

import {
  RealtimeSimulationClient,
  type SimulationSocket,
} from '../scripts/realtime-simulation-client.js';

const MODEL = 'gpt-realtime-2.1';

class FakeSocket extends EventTarget implements SimulationSocket {
  readonly sent: Readonly<Record<string, unknown>>[] = [];
  closed = false;
  onSend: (event: Readonly<Record<string, unknown>>) => void = () => {};

  send(serialized: string): void {
    const event: Readonly<Record<string, unknown>> = JSON.parse(serialized) as Readonly<
      Record<string, unknown>
    >;
    this.sent.push(event);
    this.onSend(event);
  }

  close(): void {
    this.closed = true;
  }

  emit(value: Readonly<Record<string, unknown>>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

async function connected(
  timeoutMs = 1000,
): Promise<{ client: RealtimeSimulationClient; socket: FakeSocket }> {
  const socket = new FakeSocket();
  const pending = RealtimeSimulationClient.connect({
    model: MODEL,
    clientSecret: 'test-not-a-real-secret',
    timeoutMs,
    socketFactory: (url, protocols) => {
      expect(url).toBe(`wss://api.openai.com/v1/realtime?model=${MODEL}`);
      expect(protocols).toEqual(['realtime', 'openai-insecure-api-key.test-not-a-real-secret']);
      return socket;
    },
  });
  socket.emit({ type: 'session.created', session: { model: MODEL } });
  return { client: await pending, socket };
}

describe('automated real-model simulation transport (mocked provider in unit tests)', () => {
  it('waits for acknowledgements and matches conversation item IDs', async () => {
    const { client, socket } = await connected();
    socket.onSend = (event) => {
      if (event['type'] === 'session.update') socket.emit({ type: 'session.updated' });
      else socket.emit({ type: 'conversation.item.added', item: event['item'] });
    };
    await client.updateSession({ instructions: 'Test' });
    expect(await client.createConversationItem({ id: 'mock-answer', type: 'message' })).toBe(
      'mock-answer',
    );
    expect((await client.createConversationItem({ type: 'message' })).length).toBeLessThanOrEqual(
      32,
    );
    client.close();
    expect(socket.closed).toBe(true);
  });

  it('captures genuine audio bytes and ignores responses for a different request', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({ metadata: { client_request_id: 'wanted' } });
    socket.emit({
      type: 'response.created',
      response: { id: 'unrelated', metadata: { client_request_id: 'other' } },
    });
    socket.emit({ type: 'response.done', response: { id: 'unrelated', status: 'completed' } });
    socket.emit({
      type: 'response.created',
      response: { id: 'actual', metadata: { client_request_id: 'wanted' } },
    });
    socket.emit({
      type: 'response.output_audio.delta',
      response_id: 'actual',
      delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
    });
    socket.emit({
      type: 'response.done',
      response: { id: 'actual', status: 'completed', output: [] },
    });
    const result = await pending;
    expect(result.response['id']).toBe('actual');
    expect(Buffer.concat(result.audioChunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    client.close();
  });

  it('only removes known conversation items, not out-of-band audio item IDs', async () => {
    const { client, socket } = await connected();
    await client.deleteConversationItem('not-in-conversation');
    expect(socket.sent).toHaveLength(0);
    socket.onSend = (event) =>
      socket.emit({ type: 'conversation.item.added', item: event['item'] });
    await client.createConversationItem({ id: 'participant', type: 'message' });
    socket.onSend = (event) =>
      socket.emit({ type: 'conversation.item.deleted', item_id: event['item_id'] });
    await client.deleteConversationItem('participant');
    expect(socket.sent).toHaveLength(2);
    await client.deleteConversationItem('participant');
    expect(socket.sent).toHaveLength(2);
    client.close();
  });

  it('treats an already-absent compacted item as removed without hiding other provider errors', async () => {
    const { client, socket } = await connected();
    socket.onSend = (event) =>
      socket.emit({ type: 'conversation.item.added', item: event['item'] });
    await client.createConversationItem({ id: 'participant', type: 'message' });
    socket.onSend = () =>
      socket.emit({ type: 'error', error: { code: 'item_delete_invalid_item_id' } });
    await expect(client.deleteConversationItem('participant')).resolves.toBeUndefined();
    await expect(client.respond({})).rejects.toThrow(
      'REALTIME_PROVIDER_ERROR:item_delete_invalid_item_id',
    );
    client.close();
  });

  it('rejects a substituted model and closes failed connection setup', async () => {
    const socket = new FakeSocket();
    const pending = RealtimeSimulationClient.connect({
      model: MODEL,
      clientSecret: 'test',
      socketFactory: () => socket,
    });
    socket.emit({ type: 'session.created', session: { model: 'another-model' } });
    await expect(pending).rejects.toThrow('REALTIME_MODEL_MISMATCH');
    expect(socket.closed).toBe(true);
  });

  it('surfaces provider errors without including sensitive server messages', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({});
    socket.emit({
      type: 'error',
      error: { code: 'rate_limit_exceeded', message: 'PRIVATE_PROVIDER_DETAIL' },
    });
    await expect(pending).rejects.toThrow('REALTIME_RESPONSE_NOT_COMPLETED:rate_limit_exceeded');
    const retried = client.respond({});
    socket.emit({ type: 'response.created', response: { id: 'retry' } });
    socket.emit({
      type: 'response.done',
      response: { id: 'retry', status: 'completed', output: [] },
    });
    await expect(retried).resolves.toMatchObject({ response: { status: 'completed' } });
    client.close();
  });

  it('rejects concurrent operations without disrupting the pending response', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({});
    await expect(client.updateSession({})).rejects.toThrow('CONCURRENT_REALTIME_OPERATION');
    socket.emit({ type: 'response.created', response: { id: 'actual' } });
    socket.emit({
      type: 'response.done',
      response: { id: 'actual', status: 'completed', output: [] },
    });
    await expect(pending).resolves.toMatchObject({ response: { status: 'completed' } });
    client.close();
  });

  it('rejects cancelled or incomplete responses', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({});
    socket.emit({ type: 'response.created', response: { id: 'actual' } });
    socket.emit({ type: 'response.done', response: { id: 'actual', status: 'incomplete' } });
    await expect(pending).rejects.toThrow('REALTIME_RESPONSE_NOT_COMPLETED');
    client.close();
  });

  it('retains a safe rate-limit code from response.done for bounded retry', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({});
    socket.emit({ type: 'response.created', response: { id: 'failed' } });
    socket.emit({
      type: 'response.done',
      response: {
        id: 'failed',
        status: 'failed',
        status_details: {
          error: { code: 'rate_limit_exceeded', message: 'PRIVATE_PROVIDER_DETAIL' },
        },
      },
    });
    await expect(pending).rejects.toThrow('REALTIME_RESPONSE_NOT_COMPLETED:rate_limit_exceeded');
    client.close();
  });

  it('bounds audio accumulation', async () => {
    const { client, socket } = await connected();
    const pending = client.respond({});
    socket.emit({ type: 'response.created', response: { id: 'actual' } });
    socket.emit({
      type: 'response.output_audio.delta',
      response_id: 'actual',
      delta: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
    });
    await expect(pending).rejects.toThrow('REALTIME_AUDIO_BUDGET_EXCEEDED');
    client.close();
  });

  it('times out and rejects work on a disconnected socket', async () => {
    const { client, socket } = await connected(10);
    await expect(client.respond({})).rejects.toThrow('REALTIME_OPERATION_TIMEOUT');
    client.close();
    expect(socket.closed).toBe(true);
    const second = await connected();
    const pending = second.client.respond({});
    second.socket.dispatchEvent(new Event('close'));
    await expect(pending).rejects.toThrow('REALTIME_TRANSPORT_FAILED');
    second.client.close();
  });
});
