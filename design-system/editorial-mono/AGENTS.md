# Editorial Mono — Agent notes

Project design system. Use this for UI work unless the user specifies otherwise.

## Files in this folder

| File | Use |
|------|-----|
| `README.md` | Full rules, modes, type scale |
| `tokens.json` | Machine-readable tokens + rules |
| `tokens.css` | CSS variables + `[data-theme]` remaps |
| `tokens.tailwind.css` | Tailwind v4 `@theme` block |

## Paper source of truth

https://app.paper.design/file/01M3QWCWJRM4T86M8X6Q46SQPY  
File ID: `01M3QWCWJRM4T86M8X6Q46SQPY`

## Quick rules

- Zero radius, no shadows, 1px hairlines
- Space Grotesk (display) + Space Mono (labels/body/data)
- Accent `#E6FF2B` sparingly; light mode accent text uses `#3D4500`
- Dark default tokens: `--color-*`; light: `--color-light-*`
