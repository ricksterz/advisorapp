"""Tests for the per-route <head> pre-render.

The failure this guards against is silent: a template whose tags no longer
match the substitution patterns would emit thousands of pages that still
carry the homepage canonical, which looks like a successful deploy while
Search Console keeps dropping every firm page.
"""

from __future__ import annotations

import json

import pytest

from etl.gen_static_pages import generate, render, verify_template

# Mirrors the real built index.html, including Vite's multi-line meta tags.
TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="description"
      content="Open Disclosure benchmarks every SEC-registered investment adviser."
    />
    <title>Open Disclosure — SEC Form ADV adviser benchmarking</title>

    <link rel="canonical" href="https://open-disclosure.com/" />

    <meta property="og:title" content="Open Disclosure — SEC Form ADV adviser benchmarking" />
    <meta
      property="og:description"
      content="Benchmark every SEC-registered investment adviser."
    />
    <meta property="og:url" content="https://open-disclosure.com/" />
    <meta name="twitter:title" content="Open Disclosure — SEC Form ADV adviser benchmarking" />
    <meta
      name="twitter:description"
      content="Benchmark every SEC-registered investment adviser."
    />
  </head>
  <body><div id="root"></div></body>
</html>
"""


def write_site(tmp_path, firms):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(TEMPLATE)
    data = tmp_path / "firms.json"
    data.write_text(json.dumps({"generated_at": "2026-08-09T00:00:00+00:00", "firms": firms}))
    return data, dist


def test_render_replaces_every_head_tag():
    out = render(
        TEMPLATE,
        title="ACME ADVISORS — Form ADV profile · Open Disclosure",
        description="ACME ADVISORS (CRD 1, NY): regulatory AUM.",
        canonical="https://open-disclosure.com/firm/1",
    )
    assert '<link rel="canonical" href="https://open-disclosure.com/firm/1" />' in out
    assert "<title>ACME ADVISORS — Form ADV profile · Open Disclosure</title>" in out
    assert '<meta property="og:url" content="https://open-disclosure.com/firm/1" />' in out
    # the homepage canonical must be gone, not merely supplemented
    assert 'href="https://open-disclosure.com/"' not in out
    assert "Open Disclosure — SEC Form ADV adviser benchmarking" not in out


def test_firm_names_with_html_metacharacters_are_escaped():
    out = render(
        TEMPLATE,
        title='SMITH & JONES "CAPITAL" <LLC>',
        description="A & B",
        canonical="https://open-disclosure.com/firm/2",
    )
    assert "&amp;" in out and "&quot;" in out and "&lt;LLC&gt;" in out
    # a raw quote would terminate the content attribute early
    assert '<meta property="og:title" content="SMITH &amp; JONES' in out


def test_backslash_in_name_does_not_corrupt_output():
    # re.sub treats \g and \1 in the replacement as group references, so an
    # unescaped backslash would either raise or silently splice in match text.
    out = render(
        TEMPLATE,
        title=r"A\1 \g<0> BACKSLASH LLC",
        description="d",
        canonical="https://open-disclosure.com/firm/3",
    )
    # Backslashes survive verbatim; the angle brackets are HTML-escaped, which
    # is what keeps them from closing the content attribute.
    assert r"A\1 \g&lt;0&gt; BACKSLASH LLC" in out


def test_generate_writes_one_page_per_firm(tmp_path):
    firms = [
        {"crd": 101, "legal_name": "ALPHA LLC", "business_name": "ALPHA", "state": "NY"},
        {"crd": 202, "legal_name": "BETA LLC", "business_name": None, "state": None},
    ]
    data, dist = write_site(tmp_path, firms)
    generate(data, "https://open-disclosure.com", dist, max_files=1000)

    alpha = (dist / "firm" / "101.html").read_text()
    assert '<link rel="canonical" href="https://open-disclosure.com/firm/101" />' in alpha
    assert "ALPHA (CRD 101, NY)" in alpha

    # falls back to legal_name, and omits the state clause when absent
    beta = (dist / "firm" / "202.html").read_text()
    assert "BETA LLC (CRD 202)" in beta
    assert "<title>BETA LLC — Form ADV profile · Open Disclosure</title>" in beta


def test_generate_writes_pulse_sections(tmp_path):
    data, dist = write_site(tmp_path, [])
    generate(data, "https://open-disclosure.com", dist, max_files=1000)

    assert (dist / "pulse.html").exists()
    capital = (dist / "pulse" / "capital-formation.html").read_text()
    assert (
        '<link rel="canonical" href="https://open-disclosure.com/pulse/capital-formation" />'
        in capital
    )
    assert "Capital formation — Industry Pulse · Open Disclosure" in capital


def test_file_count_guard_fails_before_the_workers_limit(tmp_path):
    firms = [{"crd": i, "legal_name": f"F{i}", "state": "NY"} for i in range(30)]
    data, dist = write_site(tmp_path, firms)
    with pytest.raises(SystemExit, match="exceeds the 10 guard"):
        generate(data, "https://open-disclosure.com", dist, max_files=10)


def test_template_that_lost_a_tag_is_rejected(tmp_path):
    # The silent-failure case: canonical tag renamed/removed by a future edit.
    broken = TEMPLATE.replace('<link rel="canonical" href="https://open-disclosure.com/" />', "")
    with pytest.raises(SystemExit, match="expected exactly 1 'canonical' tag"):
        verify_template(broken)


def test_generate_requires_a_built_template(tmp_path):
    data = tmp_path / "firms.json"
    data.write_text(json.dumps({"firms": []}))
    empty = tmp_path / "dist"
    empty.mkdir()
    with pytest.raises(SystemExit, match="run the frontend build"):
        generate(data, "https://open-disclosure.com", empty, max_files=1000)
