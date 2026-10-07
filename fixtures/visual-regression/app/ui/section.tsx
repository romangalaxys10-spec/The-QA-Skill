import type { ReactNode } from 'react';

export interface SectionProps {
  className?: string;
  children: ReactNode;
  promo?: string;
}

export function Section({ className, children, promo }: SectionProps) {
  return (
    <section className={className ? `section ${className}` : 'section'}>
      {promo ? <aside className="section-promo">{promo}</aside> : null}
      {children}
    </section>
  );
}
