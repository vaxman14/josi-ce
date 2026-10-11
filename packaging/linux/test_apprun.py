from pathlib import Path


APP_RUN = (Path(__file__).parent / 'AppRun').read_text()


def test_portable_launcher_uses_xwayland_for_cross_distro_gtk():
    assert 'export GDK_BACKEND="${GDK_BACKEND:-x11}"' in APP_RUN


def test_portable_launcher_does_not_rebase_fontconfig_root():
    assert 'FONTCONFIG_SYSROOT' not in APP_RUN
    assert 'FONTCONFIG_PATH="$APPDIR/etc/josi-fontconfig"' in APP_RUN
    assert 'FONTCONFIG_FILE="$APPDIR/etc/josi-fontconfig/portable-fonts.conf"' in APP_RUN


def test_portable_launcher_does_not_mix_host_desktop_data():
    assert 'export XDG_DATA_DIRS="$APPDIR/usr/share"' in APP_RUN


def test_portable_launcher_preserves_host_values_for_browser_handoff():
    for name in ('GDK_BACKEND', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'XDG_DATA_DIRS'):
        assert f'export JOSI_HOST_{name}="${{{name}-}}"' in APP_RUN
