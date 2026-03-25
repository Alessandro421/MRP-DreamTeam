# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project Overview

Enterprise SaaS dashboard for EMEA supply chain planning (MRP DreamTeam).
Stack: React + Vite + Supabase.

## UI/UX Design Skill — Mandatory Protocol

**Before building any UI component**, you MUST query the design skill to get
style, color, typography, and UX recommendations tailored to this project.

### How to query

```bash
python3 .claude/skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "<query>" --stack react --domain <domain>
```

Relevant domains for this project:
- `product`    — product-type recommendations (SaaS, enterprise dashboard)
- `style`      — UI styles (e.g. minimalism, dark mode, glassmorphism)
- `color`      — color palettes appropriate for supply chain / EMEA enterprise
- `typography` — font pairings with Google Fonts imports
- `chart`      — chart types and library recommendations for data-heavy dashboards
- `ux`         — best practices and anti-patterns for enterprise SaaS

### Required workflow for every UI component

1. **Query the design skill** with the component type and relevant domain(s).
   Example before building a KPI card:
   ```bash
   python3 .claude/skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "enterprise SaaS dashboard KPI card" --stack react --domain style
   python3 .claude/skills/ui-ux-pro-max/src/ui-ux-pro-max/scripts/search.py "supply chain B2B color palette" --stack react --domain color
   ```
2. **Apply the recommendations** — use the returned styles, palette, and font pairing.
3. **Build the component** following the UX guidelines returned by the skill.

### Project design context (pass to queries when relevant)

- **Product type**: Enterprise SaaS — supply chain / MRP planning
- **Target market**: EMEA (European, Middle Eastern, African enterprises)
- **Tone**: Professional, data-dense, high information hierarchy
- **Preferred aesthetic**: Clean minimalism, high-contrast data visualisation, accessible colour contrast (WCAG AA minimum)
- **Stack**: `react` (Vite, Supabase)

Do not skip this step. Design consistency across the dashboard is critical for
enterprise adoption in the EMEA market.
