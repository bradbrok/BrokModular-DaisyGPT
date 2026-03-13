import os
import threading

MAX_CONCURRENT = int(os.environ.get('MAX_CONCURRENT', 2))
MAX_PENDING = int(os.environ.get('MAX_PENDING', 10))

_semaphore = threading.Semaphore(MAX_CONCURRENT)
_pending = 0
_pending_lock = threading.Lock()
_active = 0
_active_lock = threading.Lock()


class QueueFullError(Exception):
    pass


def enqueue(fn):
    global _pending, _active

    with _pending_lock:
        if _pending >= MAX_PENDING:
            raise QueueFullError('Compilation queue is full')
        _pending += 1

    try:
        acquired = _semaphore.acquire(timeout=120)
        if not acquired:
            raise QueueFullError('Timed out waiting for compilation slot')

        with _pending_lock:
            _pending -= 1
        with _active_lock:
            _active += 1

        try:
            return fn()
        finally:
            with _active_lock:
                _active -= 1
            _semaphore.release()
    except QueueFullError:
        with _pending_lock:
            _pending -= 1
        raise


def get_queue_status():
    return {
        'pending': _pending,
        'active': _active,
        'max_concurrent': MAX_CONCURRENT,
        'max_pending': MAX_PENDING,
    }
