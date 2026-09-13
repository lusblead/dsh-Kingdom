# Third-party notices

The dsh-Kingdom npm package does not bundle its JavaScript peer dependencies
or development dependencies. Those dependencies are installed separately and
remain subject to their own licenses and notices.

No third-party artwork is included in the twelve character SVG assets; see
`ASSETS_NOTICE.md`.

## Inline GUI icons: Lucide

`src/gui/visual-assets.ts` includes a minimal, static subset of the Lucide SVG
icons. There is no Lucide runtime dependency, CDN request, or remote font.
Only SVG whitespace and the outer accessibility/class attributes were adapted;
the upstream geometry is retained.

- Project: https://github.com/lucide-icons/lucide
- Exact source revision: `a537cb6eb323b885f4c60baf3cec1a995982d167`
  (upstream commit dated 2026-09-07; retrieved 2026-09-08).
- Icon source directory: https://github.com/lucide-icons/lucide/tree/a537cb6eb323b885f4c60baf3cec1a995982d167/icons
- License source: https://github.com/lucide-icons/lucide/blob/a537cb6eb323b885f4c60baf3cec1a995982d167/LICENSE

| GUI key | Upstream SVG |
| --- | --- |
| map | `icons/map.svg` |
| management | `icons/sliders-horizontal.svg` |
| ledger | `icons/book-open.svg` |
| refresh | `icons/refresh-cw.svg` |
| chancellor | `icons/crown.svg` |
| supervisor | `icons/shield-check.svg` |
| worker | `icons/bot.svg` |
| plan | `icons/clipboard-list.svg` |
| assign | `icons/git-branch.svg` |
| next | `icons/arrow-right.svg` |
| run | `icons/play.svg` |
| review | `icons/clipboard-check.svg` |
| accept | `icons/circle-check.svg` |
| lock | `icons/lock-keyhole.svg` |
| error | `icons/circle-alert.svg` |
| idle | `icons/circle.svg` |
| unknown | `icons/circle-question-mark.svg` |
| empty | `icons/inbox.svg` |

The complete upstream license, including its Feather attribution and MIT
license, follows unchanged. These permissive terms are retained alongside the
project's AGPL-3.0-or-later license.

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
