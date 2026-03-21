import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import glob

COMPILE_TIMEOUT = int(os.environ.get('COMPILE_TIMEOUT', 60))
LIBDAISY_DIR = '/opt/daisy/libDaisy'
DAISYSP_DIR = '/opt/daisy/DaisySP'
TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'template')

TARGET_ADDRESSES = {
    'flash': '0x08000000',
    'qspi': '0x90040000',
}


def compile_code(files, target='flash', board='patch'):
    """Compile source files for Daisy hardware.

    Args:
        files: dict of {filename: content} or legacy single string
        target: 'flash' or 'qspi'
        board: board type for future board-specific builds
    """
    if isinstance(files, str):
        files = {'main.cpp': files}
    return _compile_direct(files, target, board)


def _compile_direct(files, target, board):
    """Compile directly for internal flash."""
    tmpdir = tempfile.mkdtemp(prefix='daisy-build-')

    try:
        _write_sources(tmpdir, files)
        shutil.copy(os.path.join(TEMPLATE_DIR, 'Makefile'), tmpdir)

        env = _base_env(board)
        if target == 'qspi':
            env['BOOT_TARGET'] = 'qspi'

        cpp_files = [f for f in files.keys() if f.endswith('.cpp') or f.endswith('.cc')]
        if cpp_files:
            env['CPP_SOURCES'] = ' '.join(cpp_files)

        _run_make(tmpdir, env)

        binary_data = _read_binary(tmpdir, board)
        target_address = TARGET_ADDRESSES.get(target, TARGET_ADDRESSES['flash'])
        return binary_data, target_address

    except subprocess.TimeoutExpired:
        raise TimeoutError(f'Compilation timed out after {COMPILE_TIMEOUT}s')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─── Helpers ──────────────────────────────────────────────────────

def _base_env(board):
    env = os.environ.copy()
    env['LIBDAISY_DIR'] = LIBDAISY_DIR
    env['DAISYSP_DIR'] = DAISYSP_DIR
    env['TARGET'] = board if board else 'patch'
    return env


def _write_sources(tmpdir, files):
    for filename, content in files.items():
        # Reject path traversal attempts
        if '..' in filename or filename.startswith('/') or not re.match(r'^[\w\-./]+$', filename):
            raise ValueError(f"Invalid filename: {filename}")
        filepath = os.path.join(tmpdir, filename)
        # Double-check resolved path stays within tmpdir
        real_path = os.path.realpath(filepath)
        if not real_path.startswith(os.path.realpath(tmpdir)):
            raise ValueError(f"Path traversal detected: {filename}")
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w') as f:
            f.write(content)


def _run_make(tmpdir, env):
    result = subprocess.run(
        ['make', '-C', tmpdir, '-j2'],
        capture_output=True,
        text=True,
        timeout=COMPILE_TIMEOUT,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f'compilation_failed|||{result.stderr}')


def _read_binary(tmpdir, board):
    bin_name = (board if board else 'patch') + '.bin'
    bin_path = os.path.join(tmpdir, 'build', bin_name)
    if not os.path.exists(bin_path):
        raise RuntimeError(f'compilation_failed|||Binary not found at {bin_path}')
    with open(bin_path, 'rb') as f:
        return f.read()


def _sweep_orphaned_builds():
    """Clean orphaned build directories older than 10 minutes."""
    while True:
        time.sleep(300)
        try:
            cutoff = time.time() - 600
            for d in glob.glob('/tmp/daisy-build-*'):
                if os.path.isdir(d) and os.path.getmtime(d) < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass


_sweeper = threading.Thread(target=_sweep_orphaned_builds, daemon=True)
_sweeper.start()
