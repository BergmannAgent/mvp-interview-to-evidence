import { randomUUID } from 'node:crypto';

import { z } from 'zod';

type JsonRecord = Readonly<Record<string, unknown>>;
const recordSchema = z.record(z.string(), z.unknown());
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface SimulationSocket {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RealtimeSimulationOptions {
  readonly model: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  readonly socketFactory?: (url: string, protocols: string[]) => SimulationSocket;
}

export interface SimulationResponse {
  readonly response: JsonRecord;
  readonly audioChunks: readonly Uint8Array[];
  readonly elapsedMs: number;
}

export class RealtimeResponseError extends Error {
  public constructor(
    public readonly code: string | null,
    public readonly reason: string | null,
  ) {
    super(
      `REALTIME_RESPONSE_NOT_COMPLETED${code === null ? '' : `:${code}`}${reason === null ? '' : `:${reason}`}`,
    );
  }
}

interface PendingOperation {
  readonly handle: (event: JsonRecord) => void;
  readonly reject: (error: Error) => void;
}

/** Test transport only: authentic Realtime responses with a simulated participant. */
export class RealtimeSimulationClient {
  readonly #socket: SimulationSocket;
  readonly #timeoutMs: number;
  #pending: PendingOperation | null = null;
  #failure: Error | null = null;
  readonly #conversationItems = new Set<string>();

  private constructor(options: RealtimeSimulationOptions) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#socket = (options.socketFactory ?? ((url, protocols) => new WebSocket(url, protocols)))(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`,
      ['realtime', `openai-insecure-api-key.${options.clientSecret}`],
    );
    this.#socket.addEventListener('message', this.#onMessage);
    this.#socket.addEventListener('error', this.#onTransportFailure);
    this.#socket.addEventListener('close', this.#onTransportFailure);
  }

  public static async connect(
    options: RealtimeSimulationOptions,
  ): Promise<RealtimeSimulationClient> {
    const client = new RealtimeSimulationClient(options);
    try {
      await client.#operate<void>((event, resolve) => {
        if (event['type'] !== 'session.created') return;
        const session = recordSchema.parse(event['session']);
        if (session['model'] !== options.model) throw new Error('REALTIME_MODEL_MISMATCH');
        resolve();
      });
      return client;
    } catch (error: unknown) {
      client.close();
      throw error;
    }
  }

  public async updateSession(session: JsonRecord): Promise<void> {
    await this.#operate<void>(
      (event, resolve) => {
        if (event['type'] === 'session.updated') resolve();
      },
      { type: 'session.update', session: { ...session, type: 'realtime' } },
    );
  }

  public async createConversationItem(item: JsonRecord): Promise<string> {
    const id =
      typeof item['id'] === 'string'
        ? item['id']
        : `item_${randomUUID().replace(/-/gu, '').slice(0, 24)}`;
    const createdId = await this.#operate<string>(
      (event, resolve) => {
        if (
          ![
            'conversation.item.added',
            'conversation.item.created',
            'conversation.item.done',
          ].includes(String(event['type']))
        )
          return;
        const received = recordSchema.parse(event['item']);
        if (received['id'] === id) resolve(id);
      },
      { type: 'conversation.item.create', item: { ...item, id } },
    );
    this.#conversationItems.add(createdId);
    return createdId;
  }

  public async deleteConversationItem(itemId: string): Promise<void> {
    if (!this.#conversationItems.has(itemId)) return;
    await this.#operate<void>(
      (event, resolve) => {
        if (event['type'] === 'conversation.item.deleted' && event['item_id'] === itemId) resolve();
        if (event['type'] === 'error') {
          const error = recordSchema.safeParse(event['error']);
          if (error.success && error.data['code'] === 'item_delete_invalid_item_id') resolve();
        }
      },
      { type: 'conversation.item.delete', item_id: itemId },
    );
    this.#conversationItems.delete(itemId);
  }

  public async respond(response: JsonRecord): Promise<SimulationResponse> {
    const started = performance.now();
    const chunks: Uint8Array[] = [];
    const metadata = recordSchema.safeParse(response['metadata']);
    const requestId = metadata.success ? metadata.data['client_request_id'] : undefined;
    let responseId: string | null = null;
    let audioBytes = 0;
    return this.#operate<SimulationResponse>(
      (event, resolve) => {
        if (event['type'] === 'response.created') {
          const created = recordSchema.parse(event['response']);
          const receivedMetadata = recordSchema.safeParse(created['metadata']);
          if (
            requestId !== undefined &&
            (!receivedMetadata.success || receivedMetadata.data['client_request_id'] !== requestId)
          )
            return;
          if (responseId === null) responseId = z.string().parse(created['id']);
        }
        if (
          event['response_id'] === responseId &&
          ['response.output_audio.delta', 'response.audio.delta'].includes(String(event['type']))
        ) {
          const chunk = Buffer.from(z.string().parse(event['delta']), 'base64');
          audioBytes += chunk.byteLength;
          if (audioBytes > MAX_AUDIO_BYTES) throw new Error('REALTIME_AUDIO_BUDGET_EXCEEDED');
          chunks.push(chunk);
        }
        if (event['type'] !== 'response.done') return;
        const result = recordSchema.parse(event['response']);
        if (result['id'] !== responseId) return;
        if (result['status'] !== 'completed') {
          const details = recordSchema.safeParse(result['status_details']);
          const reason = details.success ? details.data['reason'] : undefined;
          const detailError = details.success
            ? recordSchema.safeParse(details.data['error'])
            : null;
          const code = detailError?.success === true ? detailError.data['code'] : undefined;
          throw new RealtimeResponseError(safeCode(code), safeCode(reason));
        }
        resolve({
          response: result,
          audioChunks: chunks,
          elapsedMs: Math.round(performance.now() - started),
        });
      },
      { type: 'response.create', response },
    );
  }

  public close(): void {
    this.#fail(new Error('REALTIME_CONNECTION_CLOSED'));
    this.#socket.removeEventListener('message', this.#onMessage);
    this.#socket.removeEventListener('error', this.#onTransportFailure);
    this.#socket.removeEventListener('close', this.#onTransportFailure);
    this.#socket.close();
  }

  #operate<T>(
    handle: (event: JsonRecord, resolve: (value: T) => void) => void,
    request?: JsonRecord,
  ): Promise<T> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#pending !== null) return Promise.reject(new Error('CONCURRENT_REALTIME_OPERATION'));
    return new Promise<T>((resolve, reject) => {
      const settle = (result: { value: T } | { error: Error }): void => {
        clearTimeout(timer);
        this.#pending = null;
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const timer = setTimeout(
        () => this.#fail(new Error('REALTIME_OPERATION_TIMEOUT')),
        this.#timeoutMs,
      );
      // Register before send: a fast server/mock may acknowledge synchronously.
      this.#pending = {
        handle: (event) => handle(event, (value) => settle({ value })),
        reject: (error) => settle({ error }),
      };
      try {
        if (request !== undefined)
          this.#socket.send(JSON.stringify({ ...request, event_id: `evt_${randomUUID()}` }));
      } catch {
        this.#fail(new Error('REALTIME_SEND_FAILED'));
      }
    });
  }

  readonly #onMessage = (event: Event): void => {
    try {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string')
        throw new Error('INVALID_REALTIME_EVENT');
      const parsed = recordSchema.parse(JSON.parse(event.data) as unknown);
      if (parsed['type'] === 'conversation.item.deleted' && typeof parsed['item_id'] === 'string')
        this.#conversationItems.delete(parsed['item_id']);
      if (parsed['type'] === 'error') {
        // Only a pending deletion can consume the already-absent-item error.
        const pending = this.#pending;
        pending?.handle(parsed);
        if (pending !== null && this.#pending !== pending) return;
        const detail = recordSchema.parse(parsed['error']);
        const code = detail['code'];
        const param = detail['param'];
        if (code === 'rate_limit_exceeded') throw new RealtimeResponseError(code, null);
        throw new Error(
          `REALTIME_PROVIDER_ERROR:${typeof code === 'string' && /^[a-z0-9_]+$/u.test(code) ? code : 'unknown'}${typeof param === 'string' && /^[A-Za-z0-9_.]+$/u.test(param) ? `:${param}` : ''}`,
        );
      }
      this.#pending?.handle(parsed);
    } catch (error: unknown) {
      if (error instanceof RealtimeResponseError) {
        this.#pending?.reject(error);
        return;
      }
      this.#fail(error instanceof Error ? error : new Error('INVALID_REALTIME_EVENT'));
    }
  };

  readonly #onTransportFailure = (): void => {
    this.#fail(new Error('REALTIME_TRANSPORT_FAILED'));
  };

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#pending?.reject(this.#failure);
  }
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]+$/u.test(value) ? value : null;
}
