import type { ReactNode, MouseEventHandler } from 'react';

export interface IconButtonProps {
  /** Accessible name announced to screen readers and targeted by tests. */
  label: string;
  icon: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  variant?: 'ghost' | 'outline';
}

/**
 * Compact icon-only button used across NimbusDesk headers and toolbars.
 * The accessible name is part of this component's public contract: specs
 * and assistive tech both locate it by label, never by icon glyph.
 */
export function IconButton({ label, icon, onClick, variant = 'ghost' }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button icon-button--${variant}`}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
