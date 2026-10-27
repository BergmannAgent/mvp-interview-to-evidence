import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly danger?: boolean;
}

export function IconButton({
  icon: Icon,
  label,
  active = false,
  danger = false,
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`icon-button${active ? ' icon-button--active' : ''}${danger ? ' icon-button--danger' : ''} ${className}`}
      aria-label={label}
      aria-pressed={props['aria-pressed']}
      title={label}
    >
      <Icon aria-hidden="true" size={20} strokeWidth={2} />
    </button>
  );
}
