"""Fork-owned display version."""

from app import __version__

LOCAL_VERSION = "dev_0.01"
DISPLAY_VERSION = f"v{__version__.lstrip('v')}_{LOCAL_VERSION}"
