import type { SupportedLocale } from '@orgscience/contracts';
import { X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  title,
  description,
  wide = false,
  busy = false,
  interfaceLanguage = 'de',
  children,
  footer,
  onClose,
}: {
  readonly title: string;
  readonly description?: string;
  readonly wide?: boolean;
  readonly busy?: boolean;
  readonly interfaceLanguage?: SupportedLocale;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
}): ReactNode {
  const titleId = `modal-${slug(title)}-title`;
  const descriptionId = description === undefined ? undefined : `modal-${slug(title)}-description`;
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const background = [...document.body.children]
      .filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
      )
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));

    for (const entry of background) {
      entry.element.inert = true;
      entry.element.setAttribute('aria-hidden', 'true');
    }

    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      const dialog = dialogRef.current;
      const initial = dialog?.querySelector<HTMLElement>('[data-modal-initial-focus]');
      (initial ?? focusableElements(dialog)[0] ?? dialog)?.focus();
    });

    return () => {
      mounted = false;
      for (const entry of background) {
        entry.element.inert = entry.inert;
        if (entry.ariaHidden === null) entry.element.removeAttribute('aria-hidden');
        else entry.element.setAttribute('aria-hidden', entry.ariaHidden);
      }
      if (previousFocus?.isConnected === true) previousFocus.focus();
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      if (busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(dialogRef.current);
    event.preventDefault();
    if (focusable.length === 0) {
      dialogRef.current?.focus();
      return;
    }
    const currentIndex = focusable.findIndex((element) => element === document.activeElement);
    focusable[nextModalFocusIndex(currentIndex, focusable.length, event.shiftKey)]?.focus();
  };

  const modal = (
    <div className="modal-backdrop" data-modal-layer ref={backdropRef}>
      <section
        className={wide ? 'modal is-wide' : 'modal'}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={handleKeyDown}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : <p id={descriptionId}>{description}</p>}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={interfaceLanguage === 'en' ? 'Close dialog' : 'Dialog schließen'}
            title={interfaceLanguage === 'en' ? 'Close' : 'Schließen'}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
        <footer className="modal-footer">{footer}</footer>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

export function nextModalFocusIndex(
  currentIndex: number,
  focusableCount: number,
  backwards: boolean,
): number {
  if (focusableCount <= 0) return -1;
  if (currentIndex < 0) return backwards ? focusableCount - 1 : 0;
  return backwards
    ? (currentIndex - 1 + focusableCount) % focusableCount
    : (currentIndex + 1) % focusableCount;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return container === null
    ? []
    : [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.matches(':disabled') && element.closest('[inert]') === null,
      );
}

function slug(value: string): string {
  return value.toLocaleLowerCase('de-DE').replace(/[^a-z0-9]+/gu, '-');
}
