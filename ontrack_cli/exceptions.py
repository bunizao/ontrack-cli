"""Custom exceptions."""


class OnTrackCLIError(Exception):
    """Base exception for the CLI."""


class ConfigError(OnTrackCLIError):
    """Raised when configuration is missing or invalid."""


class AuthError(OnTrackCLIError):
    """Raised when authentication details are missing or rejected."""


class OnTrackAPIError(OnTrackCLIError):
    """Raised when the API returns an error."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
