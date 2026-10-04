"""Regression checks for the one-command, one-link browser installer handoff."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class BrowserHandoff(unittest.TestCase):
    def test_aio_output_is_one_browser_link_without_operator_instructions(self):
        script = (ROOT / "scripts" / "aio-install.sh").read_text()
        self.assertIn('JOSI_COMPOSE_SECRETS=1 bash ./install.sh >/dev/null', script)
        self.assertIn('daemon_os="$(docker info --format', script)
        self.assertIn('setup_host=localhost', script)
        self.assertIn('/#setup=${setup_token}', script)
        self.assertNotIn('say "Setup code:', script)
        self.assertNotIn('say "  1. Set JOSI_DOMAIN', script)
        self.assertNotIn('say "  2. docker compose', script)

    def test_private_link_pairs_automatically_and_scrubs_fragment(self):
        page = (ROOT / "services" / "installer" / "index.html").read_text()
        self.assertIn("new URLSearchParams(location.hash.slice(1))", page)
        self.assertIn("params.get('setup')", page)
        self.assertIn("history.replaceState(null,'',location.pathname+location.search)", page)
        self.assertIn("await pair(setup)", page)
        self.assertIn('id="pair" class="card hidden"', page)


if __name__ == "__main__":
    unittest.main()
