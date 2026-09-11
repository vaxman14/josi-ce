# Josi CE 0.1.4 navigation hotfix

This image derives from the exact published `0.1.4` OCI digest. It removes one
compiled member-navigation literal—the duplicate top-level Telegram entry—and
renames the JavaScript asset so existing browsers cannot reuse the old bundle.

It does not rebuild embedded source, change backend code, alter dependencies,
add migrations, or modify runtime configuration. The original asset remains in
the image but is no longer referenced by either packaged `index.html` file.
