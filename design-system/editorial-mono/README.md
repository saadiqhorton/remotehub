# Editorial Mono — Design System

Dark, typographic UI system: one loud accent, two typefaces, zero decoration. Hairlines do structure; the yellow does the talking.

**Visual source of truth (Paper):** https://app.paper.design/file/01M3QWCWJRM4T86M8X6Q46SQPY  
**Paper file ID:** `01M3QWCWJRM4T86M8X6Q46SQPY`  
**Token hash:** `58c4211e`

## For agents

When building UI for this project, use this system unless the user says otherwise.

1. Read `tokens.json` for values + rules.
2. Import `tokens.css` (or `tokens.tailwind.css` for Tailwind v4).
3. Follow the hard rules below — do not invent rounded cards, shadows, or purple accents.

## Hard rules

| Rule | Detail |
|------|--------|
| **Zero radius** | `border-radius: 0` everywhere |
| **No shadows** | Flat only |
| **Hairlines** | 1px borders using `--color-border` / `--color-light-border` |
| **Corner brackets** | L-shaped 2px accent corners mark focus on key panels |
| **Accent sparingly** | Numerals, primary CTA, status, brackets — not large backgrounds |
| **Fonts** | Display/headings: **Space Grotesk 700**. Labels, body, data: **Space Mono 400** |

## Modes

### Dark (default)

| Role | Token | Hex |
|------|-------|-----|
| Background | `--color-bg` | `#141412` |
| Surface | `--color-surface` | `#1C1B18` |
| Border | `--color-border` | `#3D3A33` |
| Muted text | `--color-muted` | `#8C8474` |
| Primary text | `--color-cream` | `#EDE6D6` |
| Accent | `--color-accent` | `#E6FF2B` |

### Light

| Role | Token | Hex |
|------|-------|-----|
| Background | `--color-light-bg` | `#EDE6D6` |
| Surface | `--color-light-surface` | `#F7F2E8` |
| Border | `--color-light-border` | `#C9C0AE` |
| Muted text | `--color-light-muted` | `#6B6456` |
| Primary text | `--color-light-ink` | `#141412` |
| Accent fill | `--color-light-accent` | `#E6FF2B` |
| Accent text on cream | `--color-light-accent-ink` | `#3D4500` |

Theme switch: set `data-theme="light"` or `data-theme="dark"` on a root element — `tokens.css` remaps semantic tokens.

## Type scale

| Name | Size | Font |
|------|------|------|
| Display | 72px | Space Grotesk Bold |
| XL | 40px | Space Grotesk Bold |
| LG | 24px | Space Grotesk Bold |
| Base | 16px / 24px lh | Space Mono |
| Label | 11px caps, 0.14em tracking | Space Mono |

## Components (patterns)

- **Primary button:** accent fill, dark text, mono uppercase
- **Secondary:** 1px ink/cream border, mono uppercase
- **Ghost:** muted underline text
- **Tags:** hairline box; active = accent border + accent text
- **Input:** surface + hairline; mono content
- **Focus card:** surface panel + four accent corner brackets

## Files

| File | Use |
|------|-----|
| `AGENTS.md` | Short agent entrypoint |
| `tokens.json` | Machine-readable tokens + rules for agents |
| `tokens.css` | CSS variables + `[data-theme]` remaps |
| `tokens.tailwind.css` | Tailwind v4 `@theme` block |
| `README.md` | This guide |

## Sync

If the Paper file changes, re-export tokens via Paper MCP (`get_tokens`) and update these files. Keep `paperFileId` and `contentHash` in `tokens.json` current.
