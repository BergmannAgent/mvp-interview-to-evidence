import type { RunStatus } from '@orgscience/contracts';
import { useI18n, type MessageKey } from '@orgscience/frontend-i18n';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RotateCw,
  SkipForward,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { ConnectionState } from '../use-monitoring.js';
import { runStatusLabel } from '../view-model.js';

interface StatusBadgeProps {
  readonly status: RunStatus;
}

export function StatusBadge({ status }: StatusBadgeProps): ReactNode {
  const { t } = useI18n();
  const Icon = statusIcon(status);
  return (
    <span className={`status-badge status-${status}`}>
      <Icon aria-hidden="true" size={13} strokeWidth={2.2} />
      {runStatusLabel(t, status)}
    </span>
  );
}

interface ConnectionBadgeProps {
  readonly state: ConnectionState;
}

export function ConnectionBadge({ state }: ConnectionBadgeProps): ReactNode {
  const { t } = useI18n();
  const labelKeys: Record<ConnectionState, MessageKey> = {
    idle: 'monitoring.connection.idle',
    connecting: 'monitoring.connection.connecting',
    live: 'monitoring.connection.live',
    reconnecting: 'monitoring.connection.reconnecting',
    offline: 'monitoring.connection.offline',
  };
  return (
    <span className={`connection-badge connection-${state}`} role="status">
      <span className="connection-dot" aria-hidden="true" />
      {t(labelKeys[state])}
    </span>
  );
}

function statusIcon(status: RunStatus): typeof Circle {
  switch (status) {
    case 'running':
      return LoaderCircle;
    case 'succeeded':
      return CircleCheck;
    case 'failed':
      return CircleAlert;
    case 'retrying':
      return RotateCw;
    case 'skipped':
      return SkipForward;
    case 'waiting':
      return Circle;
  }
}
