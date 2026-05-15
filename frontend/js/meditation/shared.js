/* Shared atoms for meditation pages: PageHead, Chip, Tag, ClaudeBlock, ContextBlock,
 * SectionTitle, StatMini, SparseNote. Each exports a function that returns an HTML
 * string — pages assemble them and set innerHTML. */

export function escapeHtml(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const e = escapeHtml

/* Inline SVG icons (Heroicons-style, stroke=currentColor). */
export const Icons = {
  chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="15 6 9 12 15 18"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>`,
  checkCircle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="9"/><polyline points="9 12 11.5 14.5 16 10"/></svg>`,
  warnDot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor"/></svg>`,
}

/* Page-level capsule header with optional back/home buttons. */
export function PageHead({ title, meta, backHref = 'javascript:history.back()', homeHref = '/' }) {
  return `
    <header class="page-head glass-pill flex items-center gap-2 mb-4">
      <a href="${e(backHref)}" class="head-btn" aria-label="Назад">${Icons.chevronLeft}</a>
      <div class="flex-1 min-w-0">
        <h1 class="font-serif-m text-[20px] leading-tight c-ink truncate">${e(title)}</h1>
        ${meta ? `<div class="text-[11px] tracking-eyebrow uppercase c-text-3 mt-0.5 truncate">${e(meta)}</div>` : ''}
      </div>
      <a href="${e(homeHref)}" class="head-btn" aria-label="На главную">${Icons.home}</a>
    </header>`
}

/* Eyebrow / section title in uppercase letter-spaced style. */
export function SectionTitle({ children, tone = 'default' }) {
  const toneClass =
    tone === 'sage' ? 'c-sage-deep' :
    tone === 'terra' ? 'c-terra-deep' :
    tone === 'gold' ? 'c-gold-deep' :
    'c-text-3'
  return `<div class="text-[11px] uppercase tracking-eyebrow ${toneClass} font-semibold">${e(children)}</div>`
}

/* Inline chip — small rounded pill with optional tone. */
export function Chip({ children, tone = 'default' }) {
  const toneClass = {
    default: 'bg-white/60 c-text border-white/70',
    sage:    'bg-sage-soft c-sage-deep border-sage-soft',
    terra:   'bg-terra-soft c-terra-deep border-terra-soft',
    gold:    'bg-amber-soft c-amber-deep border-amber-soft',
    ink:     'bg-ink-soft/10 c-ink border-ink-soft/20',
  }[tone] ?? 'bg-white/60 c-text border-white/70'
  return `<span class="chip num ${toneClass}">${e(children)}</span>`
}

/* Auto-tag with a dashed border — visually different from a Chip. */
export function Tag({ children }) {
  return `<span class="tag c-text-2">${e(children)}</span>`
}

/* "Claude-block": eyebrow + indented italic-Garamond body. The interpretation card. */
export function ClaudeBlock({ eyebrow = 'наблюдение', body, html }) {
  const content = html ?? `<p class="font-serif-m italic c-text leading-relaxed">${e(body ?? '')}</p>`
  return `
    <div class="claude-block">
      <div class="claude-eyebrow">${e(eyebrow)}</div>
      ${content}
    </div>`
}

/* Context block — heading + neutral body text. */
export function ContextBlock({ heading, body }) {
  return `
    <div class="context-block">
      ${heading ? `<div class="text-[13px] c-ink font-semibold mb-1">${e(heading)}</div>` : ''}
      <div class="text-[13px] c-text-2 leading-relaxed">${e(body)}</div>
    </div>`
}

/* SparseNote — italic Garamond caption for minor metadata under a chart. */
export function SparseNote({ children }) {
  return `<div class="font-serif-m italic c-text-3 text-[13px] leading-relaxed">${e(children)}</div>`
}

/* StatMini — small number + label, used in summary rows. */
export function StatMini({ value, label, unit }) {
  return `
    <div class="stat-mini">
      <div class="stat-value num">${e(value)}${unit ? `<span class="stat-unit">${e(unit)}</span>` : ''}</div>
      <div class="stat-label">${e(label)}</div>
    </div>`
}

/* DeltaChip — coloured pill with leading sign. NO red/green semantics —
 * just neutral indication of direction, per brief 12.5 "no evaluative colors". */
export function DeltaChip({ value, unit = '' }) {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const abs = Math.abs(value)
  return `<span class="delta-chip num">${sign}${e(formatNum(abs))}${unit ? e(unit) : ''}</span>`
}

function formatNum(v) {
  if (Math.abs(v) >= 100) return Math.round(v).toString()
  if (Math.abs(v) >= 10) return v.toFixed(1).replace('.', ',')
  return v.toFixed(2).replace('.', ',')
}

/* Format M:SS for seconds. */
export function formatMinSec(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/* Cyrillic plural helper. plural(2, 'круг', 'круга', 'кругов') → 'круга'. */
export function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/* Build a glass card wrapper. Caller supplies inner HTML. */
export function Card({ children, tone = 'default', extraClass = '' }) {
  const cls = {
    default: 'glass',
    sage: 'glass-sage',
    gold: 'glass-gold',
    terra: 'glass-terra',
    ink: 'glass-ink',
  }[tone] ?? 'glass'
  return `<div class="${cls} ${extraClass}">${children}</div>`
}

/* Stylesheet block to be embedded once on each page. */
export const STYLES = `
  /* Glass cards (subset of design tokens). */
  .glass, .glass-sage, .glass-gold, .glass-terra, .glass-ink {
    border-radius: 16px;
    padding: 14px 16px;
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    border: 1px solid rgba(255,255,255,.6);
    background: rgba(255,255,255,.55);
  }
  .glass-sage  { background: oklch(0.94 0.025 225 / 0.65); }
  .glass-gold  { background: oklch(0.95 0.025 75 / 0.55); }
  .glass-terra { background: oklch(0.95 0.025 35 / 0.55); }
  .glass-ink   { background: oklch(0.35 0.04 250 / 0.40); border-color: oklch(0.40 0.04 250 / 0.50); color: white; }

  .glass-pill {
    border-radius: 999px;
    padding: 8px 10px;
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    border: 1px solid rgba(255,255,255,.65);
    background: rgba(255,255,255,.60);
  }

  .head-btn {
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 999px;
    color: var(--ink);
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.55);
  }
  .head-btn:hover { background: rgba(255,255,255,.7); }

  /* Chips and tags. */
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    border-width: 1px;
    line-height: 1.4;
  }
  .tag {
    display: inline-block;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px dashed rgba(50, 58, 85, 0.35);
    background: transparent;
    line-height: 1.4;
  }

  /* Claude block. */
  .claude-block {
    padding: 12px 14px;
    background: oklch(0.94 0.025 225 / 0.55);
    border: 1px solid oklch(0.85 0.04 225 / 0.55);
    border-radius: 14px;
  }
  .claude-eyebrow {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--sage-deep, oklch(0.52 0.085 235));
    font-weight: 600;
    margin-bottom: 6px;
  }

  /* Context block (neutral). */
  .context-block {
    padding: 10px 12px;
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.55);
    border-radius: 12px;
  }

  /* Stat mini. */
  .stat-mini { display: flex; flex-direction: column; gap: 2px; }
  .stat-mini .stat-value {
    font-family: 'EB Garamond', Georgia, serif;
    font-size: 22px;
    line-height: 1.1;
    color: var(--ink);
  }
  .stat-mini .stat-unit { font-size: 12px; margin-left: 2px; color: var(--text-3); }
  .stat-mini .stat-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-3);
  }

  /* Delta chip. */
  .delta-chip {
    display: inline-flex; align-items: center;
    font-size: 11px; color: var(--text-2);
    padding: 2px 7px; border-radius: 999px;
    background: rgba(50,58,85,.06);
    border: 1px solid rgba(50,58,85,.12);
  }

  /* Soft background helpers used by chips. */
  .bg-sage-soft  { background: oklch(0.92 0.035 225 / 0.85); }
  .border-sage-soft  { border-color: oklch(0.85 0.06 225 / 0.50); }
  .bg-terra-soft { background: oklch(0.93 0.035 35 / 0.85); }
  .border-terra-soft { border-color: oklch(0.85 0.07 35 / 0.50); }
  .bg-amber-soft { background: oklch(0.92 0.035 75 / 0.85); }
  .border-amber-soft { border-color: oklch(0.85 0.07 75 / 0.50); }
  .bg-ink-soft\\/10 { background: oklch(0.32 0.06 250 / 0.10); }
  .border-ink-soft\\/20 { border-color: oklch(0.32 0.06 250 / 0.20); }
  .c-sage-deep  { color: oklch(0.52 0.085 235); }
  .c-terra-deep { color: oklch(0.60 0.115 25); }
  .c-amber-deep { color: oklch(0.56 0.115 70); }
  .c-gold-deep  { color: oklch(0.50 0.10 70); }
`
