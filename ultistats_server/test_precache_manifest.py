"""Tests for the deploy-time service-worker precache manifest.

Lives here because this is the repo's only pytest suite; the code under test is
the root-level increment-version.py, not the backend.

The manifest decides whether a cold offline launch finds an app or a stuck
splash screen, and it is generated, so the failure mode is silent: a bad
exclude rule quietly drops main.js and nobody notices until a phone is in
airplane mode. These pin the properties that would hurt.

Run: pytest ultistats_server/test_precache_manifest.py -q
"""
import importlib.util
import os
import pathlib

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture(scope='module')
def iv():
    spec = importlib.util.spec_from_file_location(
        'increment_version', REPO_ROOT / 'increment-version.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope='module')
def manifest(iv):
    urls, total, _too_big = iv.build_precache_manifest(str(REPO_ROOT))
    return urls, total


class TestTheShellIsComplete:
    def test_the_boot_path_is_present(self, manifest):
        """Miss any of these and the app cannot start offline at all."""
        urls, _ = manifest
        for required in ('/index.html', '/main.js', '/manifest.json'):
            assert required in urls, f'{required} missing from the precache'

    def test_the_bare_origin_is_precached_too(self, manifest):
        """A home-screen PWA launch requests '/', not '/index.html', and
        caches.match() keys on the full URL — so '/' is its own entry. This is
        the single most important request in an offline launch."""
        urls, _ = manifest
        assert '/' in urls

    def test_the_whole_module_graph_is_present(self, manifest, iv):
        """main.js imports ~80 modules; ONE missing means the graph fails and
        the splash never retracts. Checked against main.js itself rather than a
        hand-copied list, so adding a module can't silently skip this."""
        urls, _ = manifest
        main_js = (REPO_ROOT / 'main.js').read_text()
        imported = set()
        for line in main_js.splitlines():
            line = line.strip()
            if not line.startswith('import '):
                continue
            if "'./" not in line:
                continue
            path = line.split("'./")[1].split("'")[0]
            imported.add('/' + path)
        assert imported, 'parsed no imports from main.js — parser is broken'
        missing = sorted(imported - set(urls))
        assert not missing, f'modules imported by main.js but not precached: {missing}'

    def test_the_vendored_supabase_is_present(self, manifest):
        """The whole point of vendoring it (audit §4) was that a CDN copy could
        never be cached for offline use."""
        urls, _ = manifest
        assert '/vendor/supabase-js.min.js' in urls


class TestTheShellIsNotBloated:
    def test_version_json_is_never_precached(self, manifest):
        """Update detection compares the SERVER's version.json against the
        running build. Cache it and the app can never notice a new deploy."""
        urls, _ = manifest
        assert '/version.json' not in urls

    def test_the_service_worker_is_never_precached(self, manifest):
        urls, _ = manifest
        assert '/service-worker.js' not in urls

    def test_no_video_or_photography(self, manifest):
        """55 tutorial clips and 54 landing screenshots live in the deploy set.
        None are needed to boot, and precaching them would be tens of MB."""
        urls, _ = manifest
        heavy = [u for u in urls
                 if u.lower().endswith(('.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.flac'))]
        assert not heavy, f'media in the app shell: {heavy[:5]}'

    def test_nothing_that_is_not_deployed(self, manifest):
        """A manifest entry that was never uploaded is a guaranteed 404 on every
        install. Anything excluded from the S3 sync must be excluded here."""
        urls, _ = manifest
        undeployed = [u for u in urls if u.startswith(
            ('/tests/', '/scripts/', '/ultistats_server/', '/data/', '/.git',
             '/.claude/', '/.worktrees/', '/.dev-data/'))]
        assert not undeployed, f'not-deployed paths in the precache: {undeployed[:5]}'

    def test_stays_under_the_cap(self, manifest, iv):
        _, total = manifest
        assert total <= iv.PRECACHE_MAX_TOTAL_BYTES


class TestStamping:
    def test_stamp_injects_a_real_manifest(self, iv, tmp_path):
        """End-to-end: the placeholder in the committed file is replaced, and
        the result is still syntactically a JS array."""
        out_sw = tmp_path / 'sw.js'
        out_version = tmp_path / 'version.json'

        cwd = os.getcwd()
        os.chdir(REPO_ROOT)
        try:
            args = type('A', (), {
                'build': '4242', 'deploy_stamp': None, 'deploy_label': None,
                'cache_suffix': None, 'out_version': str(out_version),
                'out_sw': str(out_sw),
            })()
            iv.stamp(args)
        finally:
            os.chdir(cwd)

        sw = out_sw.read_text()
        assert "const cacheName = 'build-4242';" in sw
        assert 'const PRECACHE_URLS = [];' not in sw, 'placeholder was not replaced'
        assert "    '/index.html',\n" in sw
        # Balanced brackets: a broken substitution would corrupt the worker and
        # take offline support down with it.
        assert sw.count('const PRECACHE_URLS = [') == 1
        assert sw.split('const PRECACHE_URLS = [')[1].split('];')[0].count('[') == 0

    def test_committed_worker_keeps_the_empty_placeholder(self):
        """Stamping writes to a copy. If the committed file ever carried a real
        manifest it would rot immediately and mislead local reads."""
        sw = (REPO_ROOT / 'service-worker.js').read_text()
        assert 'const PRECACHE_URLS = [];' in sw
