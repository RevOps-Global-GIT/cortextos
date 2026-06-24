---
name: prestige-report
library: true
description: >
  Transform any content (discovery slides, call transcripts, data analysis, research reports,
  strategy documents, competitive intel, proposals, or raw notes) into a stunning, Apple-level
  single-page HTML report with scroll-triggered micro-animations, client branding pulled from
  the client's website, and modern editorial design. Always ask for the client's website URL
  first so brand colors, fonts, and voice can be lifted directly from their live site. Use this
  skill whenever someone asks to "make this beautiful", "create a report from this", "turn
  these slides into something nice", "make a client-facing version", "create an HTML overview",
  "build a landing page for this", "transform this into a presentation", "make this look
  premium", "match the client's brand", "pull their brand from their website", "use their
  colors", or any request that involves converting existing content into a polished, visually
  striking HTML deliverable. Also trigger when someone uploads a file and says "make this
  shareable", "clean this up", "make this client-ready", or even "do something cool with this".
  If the output is meant to impress (a pitch, an overview, a summary, or a showcase), this is
  the skill to use. Pairs with `revops-global-brand` and `revops-global-report` when the
  deliverable is from RevOps Global itself rather than for an external client.
---

# Prestige Report

You are building a single-file HTML report that transforms source content into something that feels like an Apple product page -clean, modern, confident, with purposeful animation that makes the content feel alive. The goal is not decoration; it's clarity elevated to art.

## Why This Matters

People share ugly documents. Slide decks get emailed as PDFs. Call transcripts sit in folders. Data analysis lives in spreadsheets nobody opens twice. When content looks and feels premium, people engage with it. They forward it. They take it seriously. This skill turns forgettable content into something people want to show to other people.

The output is a self-contained HTML file -no build tools, no dependencies, no framework. One file that opens in any browser and looks stunning.

## Your Design Philosophy

Study Apple's product pages (apple.com/iphone, apple.com/vision-pro) and Stripe's documentation. Notice what they share:

- **Extreme whitespace.** Sections breathe. Nothing feels cramped.
- **Typography does the heavy lifting.** Large, bold headlines with tight letter-spacing. Subtle, light body text. The contrast between heavy and light creates visual hierarchy without needing boxes and borders everywhere.
- **Color is restrained.** One or two accent colors, used sparingly. Most of the page is near-monochrome. When color appears, it means something.
- **Animation reveals, never distracts.** Elements appear as you scroll -not to show off, but to give the reader a sense of progression and discovery. Each section "arrives" as you reach it.
- **Cards float above the surface.** Subtle shadows, micro-interactions on hover. The page has depth without being skeuomorphic.

## Step 0: Understand the Source Content

Before writing any HTML, deeply understand what you've been given. Read every slide, every paragraph, every data point. Ask yourself:

1. **What's the story here?** Every good report has a narrative arc -a beginning (context/problem), middle (evidence/approach), and end (results/next steps). Find it.
2. **What are the key numbers?** Pull out 3-5 hero metrics that belong in the hero section.
3. **What are the natural sections?** Group content into 4-8 logical sections. Each section should have a clear purpose.
4. **What deserves visual treatment?** Which pieces of content would benefit from cards, grids, comparison tables, or timelines rather than just paragraphs?
5. **Who is the audience?** This affects tone, technical depth, and which content to emphasize.

## Step 1: Brand Discovery

The report must feel like it belongs to the client. Before writing any code, establish the brand system. Branding is the single biggest factor in whether the output feels custom or generic, so take a moment to get it right.

### Always ask for the client's website URL first

This is the default path. Before starting any build, ask:

> "What's the client's website URL? I'll pull their brand colors, fonts, and voice directly from their live site, then confirm with you before we start designing."

A live URL is the highest-fidelity brand source available. It captures color in context, real type pairings, layout rhythm, and tone of voice in one place. Skip this step only when the user explicitly says there is no client (internal use) or hands over a brand guide instead.

### Pulling brand from the URL

Once you have the URL:

1. Fetch the homepage and one or two interior pages (an "About" or "Solutions" page tends to be richer than the marketing hero).
2. Extract the primary brand color, the dark/background color, and one accent color. Look in the order: logo, primary CTA, navigation underline, link color, footer background.
3. Extract the font family by checking computed `font-family` on `<h1>` and `<body>`. Note the heading weight (often 700 or 800) and the body weight (often 400 or 450).
4. Read the headline copy on three pages. Note voice: corporate-formal, tech-casual, scientific-authoritative, founder-direct, editorial-confident.
5. Confirm what you found with the user before building:

> "I pulled Acme's brand from acme.com: primary #1B4332, dark #0A1F18, accent #D4A843, headings in Söhne Bold, body in Söhne Regular, voice reads as scientific-authoritative. Look right?"

Wait for confirmation or correction before writing any HTML.

### Fallback paths (use only when no URL is available)

If the user provides hex codes or font names directly: use them. Map to CSS variables. Skip the URL fetch.

If the user uploads a brand guide PDF or file: read the file. Extract primary color, secondary/accent color, dark background color, and font family. If the guide specifies voice or tone guidelines, note those for the content writing phase.

If the user names a company but cannot or will not share a URL: search for the company's official website and proceed with the URL-pull flow above, treating the inferred URL as a draft for the user to correct.

If the user explicitly says no brand or it is internal:
Use a sophisticated neutral palette that works for any professional context:
```
--brand-primary: #2563EB     (confident blue)
--brand-accent: #0EA5E9      (bright teal)
--brand-dark: #0F172A        (deep navy)
```
With Inter as the font family.

### Reference inspiration

These hosted reports are the visual and motion bar. Use them as quality references when calibrating type rhythm, scroll feel, and editorial pacing. They all use Supreme Group's palette; lift only the structure and motion, never the colors.

- https://app.supremegroup.ai/reports/public/50/Otsuka-Report
- https://app.supremegroup.ai/reports/public/50/presento-vision
- https://app.supremegroup.ai/reports/public/50/demand

### CSS Variable System

Always map brand elements to these CSS variables -every component references them, so changing the brand is as simple as changing the variables:

```css
:root {
  /* Brand colors -CHANGE THESE for each client */
  --brand-primary: #_____;
  --brand-primary-hover: #_____;
  --brand-dark: #_____;
  --brand-accent: #_____;

  /* Derived from brand -usually don't change these */
  --text-primary: var(--brand-dark);
  --text-secondary: #4A5568;
  --text-tertiary: #8896AB;
  --surface-0: #FFFFFF;
  --surface-1: #F7F9FC;
  --surface-2: #F0F4F8;
  --surface-3: #E8EDF4;
  --border: rgba(0,0,0,0.06);
  --border-strong: rgba(0,0,0,0.1);
  --glow-primary: rgba(R, G, B, 0.08);   /* primary at 8% opacity */
  --glow-accent: rgba(R, G, B, 0.08);    /* accent at 8% opacity */
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
```

## Step 2: Page Architecture

Every Prestige Report follows this structural pattern. Not every section is required -use what the content demands. But this is the vocabulary of components you draw from.

### Critical: Section / Container Nesting

Background colors (`.section-tinted`, `.section-dark`) must go edge-to-edge. The max-width container is always a child div inside the section, never on the section element itself. Getting this wrong creates a floating colored box instead of a full-width band.

Correct:
```html
<section class="section section-tinted">
  <div class="container">
    <!-- content here -->
  </div>
</section>
```

Wrong (causes weird floating background):
```html
<section class="section section-tinted container">
  <!-- content here -->
</section>
```

This applies to every section type: `.section-dark`, `.section-tinted`, and plain `.section`. The `<section>` handles vertical padding and background color. The `<div class="container">` or `<div class="container-wide">` inside it handles horizontal centering and max-width.

### Required Sections

#### Hero (always first)
Full-viewport dark section with brand gradient overlay. Contains:
- **Eyebrow badge**: pill with animated dot + context label (e.g., "Q4 Strategy Review", "Market Analysis")
- **Headline**: `clamp(48px, 7vw, 80px)`, weight 800, tight letter-spacing (-0.03em). Short. Punchy. Can use `<br>` for line breaks that create visual rhythm. One phrase can use a gradient text effect for emphasis.
- **Prepared for line** (optional): light, small text identifying the client
- **Subtitle**: 17-20px, light opacity, max-width 620px
- **Hero metrics**: 3-5 key numbers in an evenly spaced horizontal row with dividers. Use `display: flex; justify-content: center;` so metrics stay centered and evenly distributed. If there are 4+ metrics, reduce the gap to `32px` and ensure `flex-wrap: wrap` is set with a `row-gap` of `24px` so they wrap cleanly rather than stacking unevenly. Each metric must have a consistent width - use `min-width: 140px; text-align: center;` to keep them uniform.

```css
.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  overflow: hidden;
  background: var(--brand-dark);
}
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 70% 40%, rgba(from var(--brand-primary), 0.15) 0%, transparent 70%),
    radial-gradient(ellipse 60% 50% at 20% 80%, rgba(from var(--brand-accent), 0.08) 0%, transparent 60%);
}
```

Note: For the hero gradient, compute the actual RGBA values from the brand colors rather than using `rgba(from ...)` syntax which has limited browser support. For example, if brand-primary is #2563EB, use `rgba(37, 99, 235, 0.15)`.

#### Scroll Cue (bottom of hero)
Subtle animated arrow inviting users to scroll. Uses a `float` keyframe animation.

### Content Sections

Choose from these based on what the content needs:

#### Card Grid
For presenting 2-4 parallel concepts, offerings, or categories. Cards have gradient backgrounds, hover lift effects, tag pills, and stat rows. Use `grid-template-columns: 1fr 1fr` or `repeat(3, 1fr)` or `repeat(4, 1fr)` depending on count.

#### Pipeline / Process Flow
For sequential steps or workflows. Cards in a horizontal grid (up to 6 across) with a connecting line behind them. Each card has a numbered badge, title, description, and optional deliverable indicator pinned to the bottom via `margin-top: auto` in a flex column.

#### Dark Section
Inverts the palette to `var(--brand-dark)` background with white text. Use for emphasis sections -audit trails, key differentiators, manifesto-style statements. Accent color shifts to `var(--brand-accent)`.

#### Comparison Table
Rounded container with header row and zebra-ish rows. Good for side-by-side analysis, before/after, or feature comparisons. Use real `<table>` elements with styled `<thead>` and `<tbody>`.

#### Timeline
Horizontal card grid (4 across) with colored top-border strips. For project phases, quarterly plans, or sequential milestones.

#### Deliverable Cards
Small grid cards with icon, title, and description. For listing outputs, features, or capabilities.

#### Data Visualization Wireframes
For previewing deliverables or outputs that don't exist yet. Uses a "document frame" (browser chrome dots + tab) containing animated text bars, citation markers, and floating sidebars. These feel alive -content "generates" as you scroll.

**Where mockups live: inline within the section they describe, not in a separate gallery.** Putting all mockups in one "Sample Outputs" tab section forces the reader to discover and click tabs to see them; many won't, especially on a quick scroll. Embed each section's mockups *below the deliverables/content of that section*, separated by a `border-top` divider with a small eyebrow + heading ("Sample outputs from Q1 / What ships from the Foundation phase"). This produces editorial pacing (text → visual → text → visual) which is the Apple/Stripe pattern, and ensures every mockup gets seen on a single scroll. Page gets longer; that is the correct tradeoff for prestige feel.

If you absolutely must consolidate (e.g., source content has only one logical section that needs visuals), a single inline gallery is fine. Avoid tabbed/hidden content for one-time-read documents.

**Container nesting trap:** background-tinted or full-width section bands require `<section class="section section-tinted"><div class="container-wide">[content]</div></section>` -- the container handles centering and max-width, the section handles the background. When inserting a new component into an existing section, insert *inside* the `container-wide`, not as a sibling of it. If you cannot (e.g., scripted insertion), give the new component self-contained sizing: `max-width: 1320px; margin: 0 auto; padding: 0 32px; box-sizing: border-box;` so it self-centers regardless of where it lands.

#### Callout Box
Highlighted aside for important notes, review points, or warnings. Warm background tint with icon.

### Required Sections

#### Footer (always last)
Centered, subtle. Brand name x Client name. Date, confidentiality note.

**Required:** Every footer must always include a confidentiality line in the form **"Confidential, [Client Name]"** or **"Prepared for [Client Name], Confidential"**. Use a comma, colon, or parentheses, not an em-dash. Substitute the client's legal entity name (not the URL, not the trading shorthand). Examples: `Confidential, Acme Corporation`, `Prepared for Otsuka Pharmaceutical, Confidential`, `Confidential / RevOps Global`. This line must appear on every Prestige Report output. For internal use with no client, default to `Confidential, [Authoring Org Name]`.

## Step 3: Scroll Animation System

This is what makes a Prestige Report feel alive. The system has three layers:

### Layer 1: Section Reveals (`.reveal`)
Every content block fades up as it enters the viewport. This is the foundation animation.

**Critical: Progressive Enhancement Pattern**
Content must be visible by default. JavaScript adds a class that enables animations. If JS is blocked (some platforms strip it), the page still works perfectly -you just don't get animations.

```css
/* Default: everything visible */
.reveal { opacity: 1; transform: translateY(0); }

/* Only animate when JS is running */
.js-ready .reveal {
  opacity: 0;
  transform: translateY(32px);
  transition: opacity 0.8s var(--ease-out), transform 0.8s var(--ease-out);
}
.js-ready .reveal.visible {
  opacity: 1;
  transform: translateY(0);
}

/* Stagger siblings */
.js-ready .reveal-delay-1 { transition-delay: 0.1s; }
.js-ready .reveal-delay-2 { transition-delay: 0.2s; }
.js-ready .reveal-delay-3 { transition-delay: 0.3s; }
.js-ready .reveal-delay-4 { transition-delay: 0.4s; }
.js-ready .reveal-delay-5 { transition-delay: 0.5s; }
```

### Layer 2: Wireframe Animations (`.wf-anim`)
For deliverable preview sections. Text bars scale from left, citations pop in with bounce easing, headings fade up. Staggered via `.wf-d1` through `.wf-d12` (0.05s increments).

```css
.wf-line {
  height: 10px; border-radius: 5px; background: var(--surface-2);
  transform-origin: left; transform: scaleX(0);
  transition: transform 0.6s var(--ease-out);
}
.wf-line.animated { transform: scaleX(1); }

.wf-citation {
  transform: scale(0);
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); /* bounce */
}
.wf-citation.animated { transform: scale(1); }
```

### Layer 3: Ephemeral Elements (`.wf-anim-tip`)
Source tooltips that slide in, hold for ~3 seconds, then fade out the other direction. Creates a sense of real-time intelligence.

```css
.wf-source-tip {
  opacity: 0; transform: translateX(8px);
  transition: all 0.4s var(--ease-out);
}
.wf-source-tip.animated { opacity: 1; transform: translateX(0); }
.wf-source-tip.fade-out { opacity: 0; transform: translateX(-8px); }
```

### JavaScript (at bottom of `<body>`)

```javascript
// Progressive enhancement gate
document.documentElement.classList.add('js-ready');

// Layer 1: Section reveals
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Layer 2: Wireframe animations (fire once)
const wfObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animated');
      wfObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -20px 0px' });
document.querySelectorAll('.wf-anim').forEach(el => wfObserver.observe(el));

// Layer 3: Ephemeral tooltips
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
```

## Step 4: Typography System

Typography is the single biggest factor in whether the page feels premium or generic.

### Font Stack
Default to Inter (loaded from Google Fonts). If the client uses a specific font, substitute it.

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;450;500;600;700;800;900&display=swap');

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

### Scale
| Element | Size | Weight | Letter-spacing | Line-height |
|---------|------|--------|----------------|-------------|
| Hero H1 | `clamp(48px, 7vw, 80px)` | 800 | -0.03em | 1.05 |
| Section title | `clamp(36px, 4.5vw, 52px)` | 800 | -0.03em | 1.1 |
| Card heading | 28px | 800 | -0.02em | 1.15 |
| Subheading | 17-20px | 400 | normal | 1.65 |
| Body | 14-15px | 400 | normal | 1.7 |
| Label/eyebrow | 11-12px | 700 | 1-2px | normal |
| Metric value | 32-40px | 800 | -0.02em | 1.0 |
| Metric label | 11-13px | 500-600 | 1px, uppercase | normal |

### Rules
- Headlines are always tight: `-0.02em` to `-0.03em` letter-spacing
- Body text is loose: `line-height: 1.6-1.7`
- Labels are uppercase with wide letter-spacing
- Use `clamp()` for responsive sizing on hero and section titles
- Gradient text for emphasis: `background: linear-gradient(...); -webkit-background-clip: text; -webkit-text-fill-color: transparent;`

## Step 5: Micro-Interaction Details

These tiny touches separate "nice" from "premium":

### Card Hover
```css
.card {
  transition: all 0.35s var(--ease-out);
}
.card:hover {
  transform: translateY(-4px) to translateY(-6px);
  box-shadow: var(--shadow-elevated) or var(--shadow-float);
  border-color: transparent or rgba(brand, 0.2);
}
```

### Eyebrow Pulse
The dot in the hero eyebrow badge gently pulses:
```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.eyebrow-dot {
  animation: pulse 2s ease-in-out infinite;
  box-shadow: 0 0 12px rgba(brand-primary, 0.6);
}
```

### Scroll Cue Float
```css
@keyframes float {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(8px); }
}
```

### Pipeline Connecting Line
A 2px line runs behind step cards at the vertical center of the step numbers:
```css
.pipeline-flow::before {
  content: '';
  position: absolute;
  top: 56px;
  left: 8%; right: 8%;
  height: 2px;
  background: var(--surface-3);
}
```

## Step 6: Responsive Behavior

The page must work on all viewports. Use these breakpoints:

```css
@media (max-width: 1024px) {
  /* 6-col grids → 3-col, 4-col → 2-col */
}
@media (max-width: 768px) {
  /* Everything stacks. Reduce section padding. */
  /* Hide complex wireframe elements (audit floats, citations) */
  /* Metrics wrap */
}
```

Key responsive decisions:
- Pipeline grids collapse: 6→3→2 columns
- Card grids collapse: 4→2→1 columns
- Hero metrics: `flex-wrap: wrap` with reduced gap
- Comparison tables: `overflow-x: auto` wrapper
- Document wireframes: hide audit floats and citation markers on mobile
- Section padding reduces from `120px 0` to `80px 0`

## Step 7: Assembly

Build the file in this order:

1. Write the CSS first (inside `<style>` in `<head>`). Start with variables, then base styles, then components top-to-bottom as they appear on the page, then animations, then responsive.

2. Write the HTML sections top-to-bottom. Add `.reveal` and `.reveal-delay-N` classes to everything that should animate on scroll. Use semantic HTML -`<section>`, `<h1>`-`<h4>`, `<p>`, `<table>`.

3. Write the JavaScript at the bottom of `<body>`. Keep it minimal -just the IntersectionObserver setup.

4. Review the complete file. Check:
   - Every section has `.reveal` classes
   - Brand colors are consistent
   - All content from the source material is represented (don't drop anything important)
   - Responsive breakpoints handle all components
   - Progressive enhancement works (content visible without JS)

## Absolute Rules

### No Emojis - Ever
Never use emoji characters anywhere in the generated HTML. Not in headings, not in card content, not in callout icons, not in labels, not in list markers, not anywhere. Use inline SVG icons or simple text characters (arrows, bullets, checkmarks as HTML entities like `&#10003;`) instead. This applies to every element on the page - if you find yourself reaching for an emoji, stop and use an SVG or HTML entity instead.

### Text Contrast on Dark and Gradient Backgrounds
Every card, section, or element with a dark background (`var(--brand-dark)`, gradient from brand colors, or any background with a luminance below ~40%) must use white or near-white text. Specifically:

- `.card.primary` and `.card.accent` (gradient cards): ALL child text must be `color: white`. This includes `h3`, `p`, `.card-label`, `.card-stat-value`, `.card-stat-label`, and any other text element. Set `color: white` explicitly on the card and on every child element - do not rely on inheritance alone.
- `.section-dark`: All text inside must be white or `rgba(255,255,255, 0.5-1.0)`.
- `.dark-card`: Same - all text white, subdued text uses `rgba(255,255,255, 0.5)`.
- Callout icons inside cards: Use SVG with `fill="white"` or `fill="currentColor"` where currentColor is white.
- Never put `color: var(--text-primary)` or `color: var(--text-secondary)` (which are dark colors) on elements inside gradient or dark-background cards.

If you create any custom card variant with a colored or gradient background, the text color must be white. No exceptions. Test this mentally: "If I put dark text on this background, can I read it?" If there's any doubt, use white.

## Quality Standards

A good Prestige Report:
- **Opens and looks stunning immediately** -no loading flash, no layout shift
- **Feels effortless** -the design serves the content, never competes with it
- **Uses whitespace aggressively** -120px section padding, generous margins
- **Has a clear narrative arc** -the reader knows where they are and where they're going
- **Animates purposefully** -scroll reveals create a sense of progression
- **Works everywhere** -desktop, tablet, mobile, with or without JS
- **Is a single file** -no external dependencies except Google Fonts
- **Represents the source content faithfully** -nothing fabricated, nothing dropped

A bad Prestige Report:
- Crams everything in, afraid of whitespace
- Uses color everywhere (the whole page is the brand color)
- Animates everything in distracting ways
- Has inconsistent spacing or alignment
- Drops important content from the source material to "make it fit"
- Uses generic placeholder text instead of real content
- Looks like a Bootstrap template

## Output

Save the final HTML file to the workspace/outputs folder with a descriptive name:
`{client-or-topic}-{content-type}.html`

Examples: `acme-q4-strategy-overview.html`, `market-analysis-2026.html`, `product-launch-summary.html`

## Hosting (proposals.revopsglobal.com)

RevOps Global client proposals are hosted at `proposals.revopsglobal.com/<client-slug>` via Vercel. Use this pattern when the user wants a shareable link.

**One-time setup (already done):** Vercel project `revopsglobal-proposals` in `revops-globals-projects` team. Custom domain `proposals.revopsglobal.com` attached. Cloudflare CNAME `proposals -> cname.vercel-dns.com` with proxy OFF (Vercel handles SSL). DNS lives in Cloudflare zone for `revopsglobal.com`.

**Deploying a new proposal:**

1. Stage in `~/work/scratchpad/<client>-<year>-proposal/`. Copy the HTML to both `index.html` and `<client-slug>.html` so the slug URL works.
2. Add a `vercel.json` with noindex headers and short cache TTL:
   ```json
   {
     "cleanUrls": true,
     "trailingSlash": false,
     "headers": [
       { "source": "/(.*)", "headers": [
         { "key": "X-Robots-Tag", "value": "noindex, nofollow" },
         { "key": "Cache-Control", "value": "public, max-age=300, must-revalidate" }
       ]}
     ]
   }
   ```
3. From the staging folder: `vercel deploy --prod --yes`. The project is already linked.
4. Verify: `curl -sI https://proposals.revopsglobal.com/<slug>` should return `HTTP 200`. SSL provisions automatically on first deploy of a new subdomain (~30-120s); for subsequent deploys to the same domain it is instant.
5. For redeploys after edits, re-copy `index.html` -> `<slug>.html` then `vercel deploy --prod --yes`.

**Do not host on WPEngine.** `revopsglobal.com` apex is on WPEngine but `proposals.*` is delegated to Vercel for these static deliverables. Editing via WPEngine SFTP is the wrong path.

## Related Skills

| Skill | When to reach for it |
|-------|----------------------|
| **`prestige-report`** (you are here) | The output is a scrollable async report for a non-RevOps-Global brand. Pull colors, fonts, and voice from the client's website URL. Editorial Apple/Stripe-influenced layout. |
| **`prestige-presenter`** | The output will be presented live to an audience with a clicker. Same design DNA, but each slide fills one viewport and navigation is keyboard / click-driven, not scroll-driven. Reach for it when the request involves a meeting, board, pitch, or live demo. |
| **`revops-global-report`** | The output is from RevOps Global itself (diagnostic, assessment, vision document, strategic readout). Hard-paired with `revops-global-brand` (Urbanist, Inter, Deep Navy, Cyan-to-Mint-Teal gradient). Full scroll-depth GSAP/ScrollTrigger micro-animations, optional YouTube soundtrack, Supreme Innovation hosting flow. |
| **`revops-global-brand`** | Brand reference (colors, fonts, logo, voice). Load when the report is RevOps Global branded. |

Rule of thumb: live audience -> `prestige-presenter`. Async client share -> `prestige-report`. RevOps Global as author -> `revops-global-report`.

## Skill Notes

### What Works Well

**2026-05-27, Radisys 12-month proposal**

- **Brand pull from Drupal-style sites.** Many B2B sites (Radisys, Vitalant-style enterprise) host their child theme at `<domain>/themes/<brand>/css/child-theme.css`. Grep that file with `grep -oE '#[0-9a-fA-F]{6}'` sorted by frequency to find the primary brand color, then look for `linear-gradient` stop colors to identify signature brand gradients. Logo SVGs typically live at `/sites/default/files/logo*.svg`. This workflow returned the full Radisys palette (`#dd1c4c` primary, `#e121ce` magenta, `#dd961c` amber, `#7c008c` purple) and the official signature gradient pair in under a minute.
- **Inline logo SVG twice.** Once white (for the dark hero) using `fill="currentColor"` + a styled wrapper; once color (for the light footer) preserving the original fills. Avoids two HTTP requests and lets the white version inherit color tokens.
- **Tier-1 micro-engagement set is a strong default.** Reading progress bar, sticky right-edge section nav with inverted-on-dark behavior, animated hero metric counters (~1.1s ease-out from 0), smooth anchor scroll with URL hash sync, and cursor parallax on the hero gradient combined make the doc feel Stripe/Linear-level without any bell-and-whistle risk. Skip custom cursors, dark-mode toggles, letter-by-letter reveals, and interactive timeline scrubbers -- they read as gimmicks for one-time-read documents.
- **Big-restructure-via-Python-script.** When relocating many components (e.g., 18 mockups from one section into four sections), a single Python script that extracts, deletes, and re-inserts atomically is safer than multi-step `Edit` surgery. Always validate post-restructure: count `<div>` open/close balance, run JS through `new Function()` syntax check, count expected components per section.
- **Verify against the live URL with dev-browser headless.** `dev-browser --headless run script.js` against the deployed URL is the right verification path for hosted prestige reports. Sandbox is QuickJS (not Node) -- only `browser`, `saveScreenshot`, `setTimeout`, `console` are available. Screenshots land in `~/.dev-browser/tmp/`.

### Calibrations

**Greg-specific preferences (RevOps Global, 2026-05-27)**

- **Lead pricing with monthly retainer, not annual.** `$8,250 / month` as the headline number in hero metrics + featured pricing card. Annual total ($99,000) is a supporting field in the breakdown, not the lead. Execs budget in monthly cash terms.
- **Org-to-org framing for client docs, not person-to-person.** "Prepared for Radisys Marketing Operations" beats "Prepared for Kate Dubas." "Stated priorities" beats "Kate's priorities." Body copy refers to the client organization, not the named contact. If a formal point of contact is required, use a role-based owner line such as "Questions go to your RevOps Global account lead" rather than embedding a personal email address. Reason: the client champion shares this with their CMO/CFO/CEO and it must read as "two orgs partnering," not "a personal back-channel."
- **No tab counts on tab labels.** "Q1 Foundation 3" reads as developer noise. Just "Q1 Foundation." Numbers like "5 deliverables" can live inside the section content; they don't belong on navigation chrome.
- **Honor the source doc's stated numbers, even when they look light.** When in doubt, ship what the source plan says. If the per-line hours look underestimated (e.g., lifecycle rebuild at 24h when realistic is 80h), flag it as a side conversation but do not unilaterally rebuild the budget. Greg's frame: "defensible but true to the estimates in the original doc." A 33% increase across the board reads as scope creep to execs, even if more honest. Year-1 commits to the doc; gate-review at quarter end is where over-runs surface.
- **Strip casual conversational ballparks.** Quotes like "could be 10x that" are conversational, not commitments. Do not multiply them out ("13x step-change") and put them in the proposal copy. Replace with concrete framing: "from ~5 hrs/month to ~50 hrs/month -- dedicated senior RevOps capacity."
- **Bridging lines for apparent contradictions.** When two sections seem to contradict (priorities list says hygiene is #3, but suppression ships first in quick wins), add one sentence in each section explaining the relationship: priorities are strategic, daily execution is dependency-driven.

### Lessons Learned

**2026-05-27, Radisys 12-month proposal**

- **Quote attribution is a landmine.** I rendered a Greg-to-Kate quote as Kate-to-Greg, then Greg said Kate never said it at all (and didn't want the quote in front of execs regardless). Rule: if any uncertainty about who said what verbatim, **remove the quote entirely**. Don't risk a client recognizing a misattributed line in a doc they're sharing with their leadership. Keep the underlying point (e.g., "new internal advocate") in regular body copy where it doesn't depend on a specific quotation.
- **Tabs hide content from skim-readers.** A tabbed "Sample Outputs" section with 18 mockups across 4 tabs sounds great until you realize execs scrolling fast see only the active tab (~25% of content) and never click the others. Inline mockups within each relevant section guarantee everything gets seen. Greg's direct quote: "how do we make sure they see the tabs? Or should we make a longer scroll and put them in context with the sections?" -- the second framing is the right answer for executive proposals.
- **`container-wide` nesting bug.** Quarter-detail sections use `<section><div class="container-wide"><div class="quarter-detail">...</div></div></section>`. When inserting a sibling component (e.g., the inline mockup gallery) into the section, it must go INSIDE `container-wide`, not between `container-wide` and `</section>`. If it ends up outside, it spans full viewport width with no padding (looks like a CSS bug, is actually a nesting bug). Fix path A (preferred): correct the insertion point. Fix path B (faster, if many components are affected): give the component self-contained sizing via `max-width: 1320px; margin: auto; padding: 0 32px; box-sizing: border-box;` so it self-centers regardless of nesting.
- **Mockup labels that overlay content are fragile.** Tried `position: absolute` labels pointing at email-template blocks; they overlapped the content they were meant to label (e.g., "CTA BLOCK" pill landed on top of the "Request a demo" button). Replaced with a row of subtle pills *below* the mockup. Rule: do not overlay labels on mockup content unless you control element positions to the pixel. A row of "Header / Hero / Body / CTA / Footer" pills below the email graphic conveys "modular" without risking overlap.
- **Card-grid bottom alignment requires flex-column + `margin-top: auto`.** When cards in a grid have variable-length paragraphs but share a stats row / divider at the bottom (e.g., the four quarterly overview cards each ending with "Effort / Quarter $"), the divider lands at different vertical positions across cards by default. Cards stretch to grid row height, but content inside stacks from the top. Fix: make the card body a flex column (`display: flex; flex-direction: column; flex: 1`) and give the bottom block `margin-top: auto`. This pushes the stats row to the bottom edge regardless of paragraph length, so dividers line up across the row. Verify with `getBoundingClientRect().top` on each stats element -- all values should be identical.
- **CSS gradient `rgba(from ...)` syntax has limited browser support.** Compute the actual RGBA values from brand hex colors instead of using the newer `rgba(from var(--brand-primary), 0.15)` syntax. Old engines silently drop the rule. Worked around by hand-computing every gradient overlay.
- **PT Sans Pro and similar Adobe Typekit fonts are not Google-Fonts-loadable.** When the client uses an Adobe-only font, substitute with the closest free equivalent (Inter for sans-serif is almost always safe) and let the brand colors carry identity. Loading Inter + the closest free PT Sans alternative produced no visible difference at the design's typography scale.
- **Cloudflare proxy must be OFF for Vercel custom domains.** When creating the `proposals.revopsglobal.com` CNAME, the orange-cloud proxy must be disabled. Vercel handles its own SSL; double-proxying causes cert/handshake errors. Always confirm `"proxied": false` in the Cloudflare API call.
- **`x-vercel-cache: HIT` with `age: 339` past `max-age: 300`.** Vercel sometimes serves stale-but-correct content past max-age even with `must-revalidate`. If the user reports not seeing a change, first check the LIVE URL via curl to confirm what's actually deployed, then advise hard-refresh (Cmd+Shift+R). Don't assume it's a deploy bug.
