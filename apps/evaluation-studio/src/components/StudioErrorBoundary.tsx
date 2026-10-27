import type { SupportedLocale } from '@orgscience/contracts';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  readonly language?: SupportedLocale;
}

interface State {
  readonly failed: boolean;
}

export class StudioErrorBoundary extends Component<Props, State> {
  public override state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public override componentDidCatch(): void {
    // The boundary deliberately keeps internal details out of the configuration UI.
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const english = this.props.language !== 'de';
    return (
      <main className="fatal-state">
        <AlertTriangle aria-hidden="true" size={28} />
        <h1>
          {english
            ? 'Evaluation Studio could not be displayed'
            : 'Evaluation Studio konnte nicht dargestellt werden'}
        </h1>
        <p>
          {english
            ? 'You can reload the page without losing data.'
            : 'Die Seite kann ohne Datenverlust neu geladen werden.'}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden="true" size={16} />
          {english ? 'Reload' : 'Neu laden'}
        </button>
      </main>
    );
  }
}
