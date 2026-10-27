import { LocaleConsumer } from '@orgscience/frontend-i18n';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('interview_frontend_render_failed', {
      errorClass: error.name,
      componentStackAvailable: info.componentStack !== null,
    });
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <LocaleConsumer>
        {({ t }) => (
          <main className="fatal-error" role="alert">
            <div className="fatal-error__mark" aria-hidden="true">
              !
            </div>
            <h1>{t('interview.error.renderTitle')}</h1>
            <p>{t('interview.error.renderBody')}</p>
            <button
              type="button"
              className="button button--primary"
              onClick={() => location.reload()}
            >
              {t('common.action.reload')}
            </button>
          </main>
        )}
      </LocaleConsumer>
    );
  }
}
