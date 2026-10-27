import { createHash } from 'node:crypto';

import type { Clock, Sha256 } from '../application/index.js';

export class SystemClock implements Clock {
  public now(): string {
    return new Date().toISOString();
  }
}

export class NodeSha256 implements Sha256 {
  public digestUtf8(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
