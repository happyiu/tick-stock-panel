from app import __version__
from app.api.data import get_version
from app.api.routes import health
from app.fork_version import DISPLAY_VERSION, LOCAL_VERSION


def test_fork_display_version_is_used_by_runtime_endpoints() -> None:
    assert LOCAL_VERSION == "dev_0.01"
    assert f"v{__version__}_dev_0.01" == DISPLAY_VERSION
    assert health()["version"] == DISPLAY_VERSION
    assert get_version(None)["version"] == DISPLAY_VERSION
