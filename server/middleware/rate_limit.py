from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = None


def init_limiter(app):
    global limiter
    limiter = Limiter(
        app=app,
        key_func=get_remote_address,
        default_limits=[],
        storage_uri="memory://",
    )


def compile_rate_limit():
    """Decorator to apply to compile endpoint."""
    if limiter is None:
        raise RuntimeError('Limiter not initialized')
    return limiter.limit("10 per 15 minutes")
