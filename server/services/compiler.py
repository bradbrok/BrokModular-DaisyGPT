import os
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

def _scrub_stderr(stderr, tmpdir):
    """Remove internal paths from compiler stderr before returning to user."""
    stderr = stderr.replace(tmpdir, '<build-dir>')
    stderr = stderr.replace('/opt/daisy/libDaisy', '<libDaisy>')
    stderr = stderr.replace('/opt/daisy/DaisySP', '<DaisySP>')
    return stderr


TARGET_ADDRESSES = {
    'flash': '0x08000000',
    'qspi': '0x90040000',
}


def compile_code(code, target='flash'):
    tmpdir = tempfile.mkdtemp(prefix='daisy-build-')

    try:
        # Write user code
        with open(os.path.join(tmpdir, 'patch.cpp'), 'w') as f:
            f.write(code)

        # Copy Makefile template
        shutil.copy(os.path.join(TEMPLATE_DIR, 'Makefile'), tmpdir)

        # Set boot target via environment
        env = os.environ.copy()
        env['LIBDAISY_DIR'] = LIBDAISY_DIR
        env['DAISYSP_DIR'] = DAISYSP_DIR
        if target == 'qspi':
            env['BOOT_TARGET'] = 'qspi'

        # Run make
        result = subprocess.run(
            ['make', '-C', tmpdir, '-j2'],
            capture_output=True,
            text=True,
            timeout=COMPILE_TIMEOUT,
            env=env,
        )

        if result.returncode != 0:
            raise RuntimeError(f'compilation_failed|||{_scrub_stderr(result.stderr, tmpdir)}')

        # Read the output binary
        bin_path = os.path.join(tmpdir, 'build', 'patch.bin')
        if not os.path.exists(bin_path):
            raise RuntimeError('compilation_failed|||Binary output not found')

        with open(bin_path, 'rb') as f:
            binary_data = f.read()

        target_address = TARGET_ADDRESSES.get(target, TARGET_ADDRESSES['flash'])
        return binary_data, target_address

    except subprocess.TimeoutExpired:
        raise TimeoutError(f'Compilation timed out after {COMPILE_TIMEOUT}s')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _sweep_orphaned_builds():
    """Clean orphaned build directories older than 10 minutes."""
    while True:
        time.sleep(300)  # Check every 5 minutes
        try:
            cutoff = time.time() - 600
            for d in glob.glob('/tmp/daisy-build-*'):
                if os.path.isdir(d) and os.path.getmtime(d) < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass


# Start sweeper thread
_sweeper = threading.Thread(target=_sweep_orphaned_builds, daemon=True)
_sweeper.start()
