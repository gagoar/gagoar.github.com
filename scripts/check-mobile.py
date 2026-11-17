#!/usr/bin/env python3
"""Mobile guardrail: load a page at phone widths and fail on the usual breakage.

    python3 scripts/check-mobile.py <path-or-url> [--shots DIR]

Fails when, at 360x740 or 390x844:
  - the page scrolls sideways (scrollWidth > innerWidth)
  - a visible link or button is shorter than 44px (WCAG 2.5.5 target size)
Saves a full-page screenshot per viewport when --shots is given.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

VIEWPORTS = [(360, 740), (390, 844)]
MIN_TARGET = 44

# Links inside running prose are exempt from the target-size rule (WCAG "inline" exception).
SMALL_TARGETS_JS = """
() => [...document.querySelectorAll('a[href], button')]
  .filter(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (el.closest('p, li > span, .callout-val') && cs.display === 'inline') return false;
    return r.height < %d;
  })
  .map(el => ({text: (el.textContent || '').trim().slice(0, 40), h: Math.round(el.getBoundingClientRect().height)}))
""" % MIN_TARGET


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--shots")
    args = ap.parse_args()

    url = args.target if "://" in args.target else pathlib.Path(args.target).resolve().as_uri()
    shots = pathlib.Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w, h in VIEWPORTS:
            page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2, has_touch=True, is_mobile=True)
            page.goto(url, wait_until="load")
            scroll_w = page.evaluate("document.documentElement.scrollWidth")
            if scroll_w > w:
                failures.append(f"{w}px: page scrolls sideways (scrollWidth {scroll_w})")
            for t in page.evaluate(SMALL_TARGETS_JS):
                failures.append(f"{w}px: tap target {t['h']}px high: {t['text']!r}")
            if shots:
                page.screenshot(path=str(shots / f"{w}x{h}.png"), full_page=True)
            page.close()
        browser.close()

    if failures:
        print("\n".join(f"FAIL {f}" for f in failures))
        return 1
    print(f"ok: {url} passes at {', '.join(f'{w}px' for w, _ in VIEWPORTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
