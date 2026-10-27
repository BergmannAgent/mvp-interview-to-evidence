import { Braces } from 'lucide-react';
import type { ReactNode } from 'react';

interface JsonDetailsProps {
  readonly label: string;
  readonly value: unknown;
  readonly open?: boolean;
}

export function JsonDetails({ label, value, open = false }: JsonDetailsProps): ReactNode {
  return (
    <details className="json-details" open={open}>
      <summary>
        <Braces aria-hidden="true" size={14} />
        {label}
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
