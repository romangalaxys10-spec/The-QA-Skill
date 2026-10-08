import { Section } from './section';

export const HERO_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

export type HeroViewport = (typeof HERO_VIEWPORTS)[number];

export interface HeroCopy {
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel: string;
}

export interface HeroVisual {
  src: string;
  alt: string;
}

/**
 * Home page hero, reworked for the spring campaign: a two-column grid that
 * places the campaign visual beside the copy on every viewport. The visual
 * specs import HERO_VIEWPORTS so the responsive contract has a single
 * source of truth shared with the product component.
 */
export function HeroSection({
  copy,
  visual,
  promo,
}: {
  copy: HeroCopy;
  visual: HeroVisual;
  promo?: string;
}) {
  return (
    <Section className="hero" promo={promo}>
      <div className="hero-grid hero-grid--two-col">
        <div className="hero-copy">
          <p className="hero-eyebrow">{copy.eyebrow}</p>
          <h1 className="hero-headline">{copy.headline}</h1>
          <p className="hero-body">{copy.body}</p>
          <a className="hero-cta" href="/shop">
            {copy.ctaLabel}
          </a>
        </div>
        <figure className="hero-visual">
          <img src={visual.src} alt={visual.alt} />
        </figure>
      </div>
    </Section>
  );
}
