# Prestige Report -Complete Design System Reference

This file contains the full CSS component library. When building a Prestige Report, read this file and copy the components you need. You don't need every component -pick the ones that serve the content.

## Table of Contents
1. [Base Styles & Variables](#base)
2. [Hero Section](#hero)
3. [Section Layouts](#sections)
4. [Card Grid](#card-grid)
5. [Pipeline / Process Flow](#pipeline)
6. [Comparison Table](#comparison)
7. [Timeline](#timeline)
8. [Deliverable Cards](#deliverable-cards)
9. [Callout Box](#callout)
10. [Dark Section Cards](#dark-cards)
11. [Document Wireframe](#wireframe)
12. [Footer](#footer)
13. [Scroll Animations](#animations)
14. [Responsive Breakpoints](#responsive)
15. [Full JavaScript Block](#javascript)

---

## Base Styles & Variables {#base}

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;450;500;600;700;800;900&display=swap');

:root {
  /* ═══ BRAND -Change these per client ═══ */
  --brand-primary: #2563EB;
  --brand-primary-hover: #3B82F6;
  --brand-dark: #0F172A;
  --brand-accent: #0EA5E9;

  /* ═══ SYSTEM -Derived, rarely change ═══ */
  --text-primary: #15191E;
  --text-secondary: #4A5568;
  --text-tertiary: #8896AB;
  --surface-0: #FFFFFF;
  --surface-1: #F7F9FC;
  --surface-2: #F0F4F8;
  --surface-3: #E8EDF4;
  --border: rgba(0,0,0,0.06);
  --border-strong: rgba(0,0,0,0.1);
  --glow-primary: rgba(37, 99, 235, 0.08);
  --glow-accent: rgba(14, 165, 233, 0.08);
  --shadow-subtle: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-card: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
  --shadow-elevated: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-float: 0 12px 48px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04);
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  --ease: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--text-primary);
  background: var(--surface-0);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}

.container { max-width: 1120px; margin: 0 auto; padding: 0 32px; }
.container-wide { max-width: 1280px; margin: 0 auto; padding: 0 32px; }
```

## Hero Section {#hero}

```css
.hero {
  min-height: 100vh;
  display: flex; flex-direction: column; justify-content: center;
  position: relative; overflow: hidden;
  background: var(--brand-dark);
}
.hero::before {
  content: ''; position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 70% 40%, rgba(37,99,235,0.15) 0%, transparent 70%),
    radial-gradient(ellipse 60% 50% at 20% 80%, rgba(14,165,233,0.08) 0%, transparent 60%);
}
.hero-content { position: relative; z-index: 1; padding: 0 0 80px; }

.hero-eyebrow {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 8px 20px 8px 12px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 999px;
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.7);
  margin-bottom: 40px; backdrop-filter: blur(12px);
}
.hero-eyebrow-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--brand-primary);
  box-shadow: 0 0 12px rgba(37,99,235,0.6);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

.hero h1 {
  font-size: clamp(48px, 7vw, 80px); font-weight: 800;
  line-height: 1.05; letter-spacing: -0.03em;
  color: white; margin-bottom: 28px; max-width: 900px;
}
.gradient-text {
  background: linear-gradient(135deg, #4DA3FF 0%, #0EA5E9 50%, #6DD5FA 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero-subtitle {
  font-size: clamp(17px, 2vw, 20px); font-weight: 400;
  line-height: 1.65; color: rgba(255,255,255,0.55);
  max-width: 620px; margin-bottom: 48px;
}
.hero-metrics {
  display: flex; justify-content: center; gap: 48px;
  flex-wrap: wrap; row-gap: 24px;
}
.hero-metric { position: relative; min-width: 140px; text-align: center; }
.hero-metric::before {
  content: ''; position: absolute; left: -24px; top: 4px; bottom: 4px;
  width: 1px; background: rgba(255,255,255,0.1);
}
.hero-metric:first-child::before { display: none; }
.hero-metric-value {
  font-size: 40px; font-weight: 800; color: white;
  letter-spacing: -0.02em; line-height: 1;
}
.hero-metric-label {
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.4);
  text-transform: uppercase; letter-spacing: 1px; margin-top: 6px;
}

.scroll-cue {
  position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  color: rgba(255,255,255,0.25); font-size: 11px; font-weight: 500;
  letter-spacing: 2px; text-transform: uppercase;
  animation: float 3s ease-in-out infinite;
}
@keyframes float {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(8px); }
}
```

## Section Layouts {#sections}

```css
.section { padding: 120px 0; }
.section-dark { background: var(--brand-dark); color: white; }
.section-tinted { background: var(--surface-1); }

.section-label {
  font-size: 12px; font-weight: 700; letter-spacing: 2px;
  text-transform: uppercase; color: var(--brand-primary); margin-bottom: 16px;
}
.section-dark .section-label { color: var(--brand-accent); }
.section-title {
  font-size: clamp(36px, 4.5vw, 52px); font-weight: 800;
  line-height: 1.1; letter-spacing: -0.03em;
  margin-bottom: 20px; max-width: 700px;
}
.section-subtitle {
  font-size: 18px; font-weight: 400; line-height: 1.7;
  color: var(--text-secondary); max-width: 580px;
}
.section-dark .section-subtitle { color: rgba(255,255,255,0.5); }
```

## Card Grid {#card-grid}

```css
.card-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 24px; margin-top: 64px;
}
.card {
  position: relative; border-radius: var(--radius-lg);
  padding: 44px 40px 40px; overflow: hidden;
  transition: transform 0.4s var(--ease-out), box-shadow 0.4s var(--ease-out);
  cursor: default;
}
.card:hover { transform: translateY(-4px); box-shadow: var(--shadow-float); }
/* CRITICAL: gradient cards MUST have white text on ALL child elements */
.card.primary { background: linear-gradient(160deg, var(--brand-primary) 0%, color-mix(in srgb, var(--brand-primary) 70%, black) 100%); color: white; }
.card.accent { background: linear-gradient(160deg, var(--brand-accent) 0%, color-mix(in srgb, var(--brand-accent) 70%, black) 100%); color: white; }
.card.primary *, .card.accent * { color: white; }
.card.primary p, .card.accent p { color: white; opacity: 0.75; }
.card.primary .card-label, .card.accent .card-label { color: white; opacity: 0.6; }
.card.primary .card-stat-label, .card.accent .card-stat-label { color: white; opacity: 0.5; }
.card::before {
  content: ''; position: absolute; inset: 0;
  background: radial-gradient(circle at 80% 20%, rgba(255,255,255,0.1) 0%, transparent 60%);
}
.card-inner { position: relative; z-index: 1; }
.card-label {
  font-size: 11px; font-weight: 700; letter-spacing: 2px;
  text-transform: uppercase; opacity: 0.6; margin-bottom: 16px;
}
.card h3 {
  font-size: 28px; font-weight: 800; line-height: 1.15;
  letter-spacing: -0.02em; margin-bottom: 16px;
}
.card p { font-size: 15px; line-height: 1.7; opacity: 0.75; margin-bottom: 28px; }
.card-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 32px; }
.card-tag {
  padding: 5px 14px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: rgba(255,255,255,0.15); backdrop-filter: blur(8px);
}
.card-stats {
  display: flex; gap: 32px; padding-top: 24px;
  border-top: 1px solid rgba(255,255,255,0.15);
}
.card-stat-value { font-size: 32px; font-weight: 800; line-height: 1; }
.card-stat-label {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.8px; opacity: 0.5; margin-top: 4px;
}
```

## Pipeline / Process Flow {#pipeline}

```css
.pipeline-header {
  display: flex; justify-content: space-between;
  align-items: flex-end; margin-bottom: 48px;
}
.pipeline-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 16px; border-radius: 999px;
  font-size: 12px; font-weight: 700; letter-spacing: 1px;
}
.pipeline-badge.primary { background: var(--glow-primary); color: var(--brand-primary); }
.pipeline-badge.accent { background: var(--glow-accent); color: var(--brand-accent); }
.pipeline-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.pipeline-flow {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px; position: relative; margin-bottom: 32px;
}
.pipeline-flow::before {
  content: ''; position: absolute; top: 56px;
  left: 8%; right: 8%; height: 2px;
  background: var(--surface-3); z-index: 0;
}

.step-card {
  position: relative; z-index: 1; background: var(--surface-0);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 20px 16px 18px; display: flex; flex-direction: column;
  transition: all 0.35s var(--ease-out);
}
.step-card:hover {
  border-color: transparent; box-shadow: var(--shadow-elevated);
  transform: translateY(-6px);
}

.step-number {
  width: 32px; height: 32px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 800; color: white;
  margin-bottom: 16px; background: var(--brand-primary);
}
.step-title {
  font-size: 13px; font-weight: 700; color: var(--text-primary);
  line-height: 1.35; margin-bottom: 8px; min-height: 36px;
}
.step-desc {
  font-size: 12px; color: var(--text-tertiary);
  line-height: 1.6; margin-bottom: 14px;
}

/* Deliverable pinned to card bottom */
.step-deliverable {
  margin-top: auto; padding-top: 12px;
  border-top: 1px solid var(--border);
}
.step-deliverable-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.8px;
  text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 6px;
}
.step-deliverable-item {
  display: flex; align-items: flex-start; gap: 6px;
  font-size: 12px; font-weight: 600; line-height: 1.5;
  color: var(--brand-primary); min-height: 36px;
}
```

## Comparison Table {#comparison}

```css
.comparison-table-wrap {
  margin-top: 64px; border-radius: var(--radius-lg);
  overflow: hidden; border: 1px solid var(--border);
  background: white; box-shadow: var(--shadow-card);
}
.comparison-table { width: 100%; border-collapse: collapse; }
.comparison-table thead th {
  padding: 18px 28px; font-size: 12px; font-weight: 700;
  letter-spacing: 1px; text-transform: uppercase; text-align: left;
  background: var(--surface-1); border-bottom: 1px solid var(--border);
  color: var(--text-tertiary);
}
.comparison-table tbody td {
  padding: 16px 28px; font-size: 14px; line-height: 1.6;
  border-bottom: 1px solid var(--border); color: var(--text-secondary);
}
.comparison-table tbody tr:last-child td { border-bottom: none; }
.comparison-table tbody td:first-child {
  font-weight: 600; color: var(--text-primary); width: 22%;
}
```

## Timeline {#timeline}

```css
.timeline-track {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 16px; margin-top: 64px;
}
.timeline-card {
  border-radius: var(--radius-lg); padding: 32px 28px;
  background: var(--surface-0); border: 1px solid var(--border);
  position: relative; overflow: hidden;
  transition: all 0.35s var(--ease-out);
}
.timeline-card:hover { box-shadow: var(--shadow-elevated); transform: translateY(-4px); }
.timeline-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: var(--brand-primary);
}
.timeline-label {
  font-size: 11px; font-weight: 700; letter-spacing: 1.5px;
  text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 8px;
}
.timeline-card h4 {
  font-size: 18px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px;
}
.timeline-items { list-style: none; }
.timeline-items li {
  font-size: 13px; color: var(--text-secondary);
  padding: 5px 0 5px 20px; position: relative; line-height: 1.5;
}
.timeline-items li::before {
  content: ''; position: absolute; left: 0; top: 12px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--surface-3);
}
```

## Deliverable Cards {#deliverable-cards}

```css
.deliverables-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 16px; margin-top: 64px;
}
.deliverable-card {
  padding: 32px 24px; border-radius: var(--radius-lg);
  border: 1px solid var(--border); background: white;
  text-align: center; transition: all 0.35s var(--ease-out);
}
.deliverable-card:hover { box-shadow: var(--shadow-elevated); transform: translateY(-4px); }
.deliverable-icon {
  width: 52px; height: 52px; border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 16px;
}
.deliverable-icon.primary { background: var(--glow-primary); }
.deliverable-icon.accent { background: var(--glow-accent); }
.deliverable-icon.green { background: rgba(56,161,105,0.08); }
.deliverable-icon.amber { background: rgba(237,137,54,0.08); }
.deliverable-card h4 {
  font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px;
}
.deliverable-card p { font-size: 13px; color: var(--text-tertiary); line-height: 1.6; }
```

## Callout Box {#callout}

```css
.callout {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 24px; border-radius: var(--radius-md);
}
.callout.warm { background: #FFFBF5; border: 1px solid #F5DEB3; }
.callout.info { background: rgba(37,99,235,0.04); border: 1px solid rgba(37,99,235,0.12); }
.callout-icon {
  width: 36px; height: 36px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; font-size: 16px;
}
.callout.warm .callout-icon { background: #FFF0D4; }
.callout.info .callout-icon { background: var(--glow-primary); }
.callout-text { font-size: 14px; line-height: 1.5; }
.callout.warm .callout-text { color: #7C5C1F; }
.callout.info .callout-text { color: var(--text-secondary); }
```

## Dark Section Cards {#dark-cards}

```css
.dark-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 20px; margin-top: 64px;
}
.dark-card {
  padding: 36px 32px; border-radius: var(--radius-lg);
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  transition: all 0.35s var(--ease-out);
}
.dark-card:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.1);
  transform: translateY(-4px);
}
.dark-icon {
  width: 44px; height: 44px; border-radius: 12px;
  background: rgba(14,165,233,0.12);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 20px;
}
.dark-card h4 { font-size: 17px; font-weight: 700; margin-bottom: 10px; color: white; }
.dark-card p { font-size: 14px; line-height: 1.7; color: rgba(255,255,255,0.5); }
```

## Document Wireframe {#wireframe}

Use this component to preview deliverables. The browser chrome frame creates context, and animated text bars create a sense of content being generated.

```css
.wireframe-section { padding: 80px 0 120px; }
.wireframe-intro { text-align: center; margin-bottom: 48px; }
.wireframe-intro-label {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 16px; border-radius: 999px;
  font-size: 11px; font-weight: 700;
  letter-spacing: 1px; text-transform: uppercase; margin-bottom: 16px;
}
.wireframe-intro-title {
  font-size: 22px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;
}
.wireframe-intro-sub { font-size: 14px; color: var(--text-tertiary); }

/* Browser chrome frame */
.doc-frame {
  max-width: 820px; margin: 0 auto; background: white;
  border-radius: 12px; border: 1px solid var(--border);
  box-shadow: 0 8px 40px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  overflow: hidden; position: relative;
}
.doc-chrome {
  display: flex; align-items: center; gap: 6px;
  padding: 12px 20px; background: var(--surface-1);
  border-bottom: 1px solid var(--border);
}
.doc-chrome-dot { width: 8px; height: 8px; border-radius: 50%; }
.doc-chrome-dot:nth-child(1) { background: #FF5F57; }
.doc-chrome-dot:nth-child(2) { background: #FEBC2E; }
.doc-chrome-dot:nth-child(3) { background: #28C840; }
.doc-chrome-tab {
  margin-left: 16px; font-size: 11px; font-weight: 600;
  color: var(--text-tertiary); padding: 4px 12px;
  background: white; border-radius: 6px; border: 1px solid var(--border);
}
.doc-body { padding: 48px 56px 56px; }

/* Animated text bars */
.wf-line {
  height: 10px; border-radius: 5px; background: var(--surface-2);
  margin-bottom: 8px; transform-origin: left; transform: scaleX(0);
  transition: transform 0.6s var(--ease-out);
}
.wf-line.animated { transform: scaleX(1); }
.wf-line.thick { height: 14px; }
.wf-line.thin { height: 7px; }
.wf-gap { margin-bottom: 24px; }

/* Staggered delay classes */
.wf-d1 { transition-delay: 0.05s; }
.wf-d2 { transition-delay: 0.1s; }
.wf-d3 { transition-delay: 0.15s; }
.wf-d4 { transition-delay: 0.2s; }
.wf-d5 { transition-delay: 0.25s; }
.wf-d6 { transition-delay: 0.3s; }
.wf-d7 { transition-delay: 0.35s; }
.wf-d8 { transition-delay: 0.4s; }
.wf-d9 { transition-delay: 0.45s; }
.wf-d10 { transition-delay: 0.5s; }
.wf-d11 { transition-delay: 0.55s; }
.wf-d12 { transition-delay: 0.6s; }

/* Section headers inside wireframe */
.wf-section-label {
  font-size: 10px; font-weight: 700; letter-spacing: 1.5px;
  text-transform: uppercase; margin-bottom: 8px;
  opacity: 0; transform: translateX(-12px);
  transition: all 0.5s var(--ease-out);
}
.wf-section-label.animated { opacity: 1; transform: translateX(0); }

.wf-heading {
  font-size: 18px; font-weight: 800; color: var(--text-primary);
  margin-bottom: 16px; opacity: 0; transform: translateY(8px);
  transition: all 0.5s var(--ease-out); letter-spacing: -0.02em;
}
.wf-heading.animated { opacity: 1; transform: translateY(0); }
.wf-heading.large { font-size: 26px; margin-bottom: 6px; }

.wf-divider {
  height: 1px; background: var(--border); margin: 28px 0;
  transform-origin: left; transform: scaleX(0);
  transition: transform 0.8s var(--ease-out);
}
.wf-divider.animated { transform: scaleX(1); }

/* Citation markers */
.wf-citation {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 4px;
  font-size: 8px; font-weight: 800; color: white;
  position: absolute; right: 56px;
  transform: scale(0);
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.wf-citation.animated { transform: scale(1); }

/* Source tooltips */
.wf-source-tip {
  position: absolute; right: 80px; padding: 6px 12px;
  border-radius: 8px; font-size: 10px; font-weight: 500;
  color: white; white-space: nowrap;
  opacity: 0; transform: translateX(8px);
  transition: all 0.4s var(--ease-out); pointer-events: none;
}
.wf-source-tip.animated { opacity: 1; transform: translateX(0); }
.wf-source-tip.fade-out { opacity: 0; transform: translateX(-8px); }

/* Verification badges */
.wf-verify {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px;
  background: rgba(56,161,105,0.08); color: #38A169;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
  text-transform: uppercase; transform: scale(0);
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: left;
}
.wf-verify.animated { transform: scale(1); }
```

## Footer {#footer}

```css
.footer {
  padding: 40px 0; border-top: 1px solid var(--border); text-align: center;
}
.footer-text { font-size: 13px; color: var(--text-tertiary); }
.footer-text strong { color: var(--text-primary); font-weight: 600; }
.footer-sub {
  font-size: 12px; color: var(--text-tertiary);
  opacity: 0.6; margin-top: 4px;
}
```

## Scroll Animations {#animations}

```css
/* Progressive enhancement: content visible by default */
.reveal { opacity: 1; transform: translateY(0); }
.js-ready .reveal {
  opacity: 0; transform: translateY(32px);
  transition: opacity 0.8s var(--ease-out), transform 0.8s var(--ease-out);
}
.js-ready .reveal.visible { opacity: 1; transform: translateY(0); }
.js-ready .reveal-delay-1 { transition-delay: 0.1s; }
.js-ready .reveal-delay-2 { transition-delay: 0.2s; }
.js-ready .reveal-delay-3 { transition-delay: 0.3s; }
.js-ready .reveal-delay-4 { transition-delay: 0.4s; }
.js-ready .reveal-delay-5 { transition-delay: 0.5s; }
```

## Responsive Breakpoints {#responsive}

```css
@media (max-width: 1024px) {
  .pipeline-flow { grid-template-columns: repeat(3, 1fr); }
  .timeline-track { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 768px) {
  .section { padding: 80px 0; }
  .card-grid { grid-template-columns: 1fr; }
  .pipeline-flow { grid-template-columns: 1fr 1fr; }
  .pipeline-flow::before { display: none; }
  .dark-grid { grid-template-columns: 1fr; }
  .deliverables-grid { grid-template-columns: 1fr 1fr; }
  .timeline-track { grid-template-columns: 1fr; }
  .hero-metrics { gap: 24px; row-gap: 20px; flex-wrap: wrap; justify-content: center; }
  .comparison-table-wrap { overflow-x: auto; }
  .doc-body { padding: 28px 24px 32px; }
  .wf-audit-float { display: none; }
  .wf-pillars { grid-template-columns: 1fr; }
  .wf-citation, .wf-source-tip { display: none; }
}
```

## Full JavaScript Block {#javascript}

Place this at the bottom of `<body>`, right before `</body>`:

```javascript
<script>
document.documentElement.classList.add('js-ready');

// Section reveals
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Wireframe animations (fire once)
const wfObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animated');
      wfObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -20px 0px' });
document.querySelectorAll('.wf-anim').forEach(el => wfObserver.observe(el));

// Ephemeral source tooltips
const tipObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animated');
      tipObserver.unobserve(entry.target);
      setTimeout(() => entry.target.classList.add('fade-out'), 3200);
    }
  });
}, { threshold: 0.3 });
document.querySelectorAll('.wf-anim-tip').forEach(el => tipObserver.observe(el));
</script>
```
