import pytest

import ontrack_cli.cli as cli_module
from ontrack_cli.exceptions import ConfigError


def test_main_prints_okta_auth_hint_for_missing_credentials(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        cli_module,
        "cli",
        lambda **_kwargs: (_ for _ in ()).throw(ConfigError("Missing OnTrack credentials.")),
    )

    with pytest.raises(SystemExit) as exc:
        cli_module.main()

    assert exc.value.code == 1
    stderr = capsys.readouterr().err
    assert "Config error: Missing OnTrack credentials." in stderr
    assert "Tired of expired browser cookies? Try okta-auth" in stderr
    assert "https://github.com/bunizao/okta-auth" in stderr
    assert "Install with uv tool install okta-auth-cli, then run okta config." in stderr
