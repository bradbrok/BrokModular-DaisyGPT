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

# Internal flash is 128 KB; programmer overhead is ~15 KB
MAX_QSPI_APP_SIZE = 115000

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

    if target == 'qspi':
        return _compile_qspi_programmer(files, board)
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


def _compile_qspi_programmer(files, board):
    """Compile a QSPI app, then wrap it in an internal-flash programmer.

    The programmer boots from 0x08000000, writes the embedded firmware to
    QSPI flash at 0x90040000, and jumps to the application.  This lets us
    flash via the STM32 ROM DFU bootloader (which only supports internal flash).
    """
    tmpdir = tempfile.mkdtemp(prefix='daisy-build-')

    try:
        # --- Phase 1: compile user app for QSPI ---
        _write_sources(tmpdir, files)
        shutil.copy(os.path.join(TEMPLATE_DIR, 'Makefile'), tmpdir)

        env = _base_env(board)
        env['BOOT_TARGET'] = 'qspi'

        cpp_files = [f for f in files.keys() if f.endswith('.cpp') or f.endswith('.cc')]
        if cpp_files:
            env['CPP_SOURCES'] = ' '.join(cpp_files)

        _run_make(tmpdir, env)
        qspi_binary = _read_binary(tmpdir, board)

        if len(qspi_binary) > MAX_QSPI_APP_SIZE:
            raise RuntimeError(
                f'compilation_failed|||QSPI app is {len(qspi_binary)} bytes, '
                f'max {MAX_QSPI_APP_SIZE} bytes for programmer-based flashing'
            )

        # --- Phase 2: generate app_data.h from the QSPI binary ---
        header = _generate_app_data_header(qspi_binary)
        with open(os.path.join(tmpdir, 'app_data.h'), 'w') as f:
            f.write(header)

        # --- Phase 3: compile the programmer for internal flash ---
        # Clean previous build artifacts
        build_dir = os.path.join(tmpdir, 'build')
        if os.path.isdir(build_dir):
            shutil.rmtree(build_dir)

        # Remove user source files and old Makefile, copy programmer source + minimal Makefile
        for fn in list(files.keys()):
            path = os.path.join(tmpdir, fn)
            if os.path.exists(path):
                os.remove(path)
        os.remove(os.path.join(tmpdir, 'Makefile'))

        shutil.copy(
            os.path.join(TEMPLATE_DIR, 'qspi_programmer.cpp'),
            tmpdir,
        )
        shutil.copy(
            os.path.join(TEMPLATE_DIR, 'Makefile.programmer'),
            os.path.join(tmpdir, 'Makefile'),
        )

        env2 = _base_env(board)
        env2['CPP_SOURCES'] = 'qspi_programmer.cpp'

        _run_make(tmpdir, env2)
        programmer_binary = _read_binary(tmpdir, board)

        # Programmer targets internal flash
        return programmer_binary, '0x08000000'

    except subprocess.TimeoutExpired:
        raise TimeoutError(f'Compilation timed out after {COMPILE_TIMEOUT}s')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _generate_app_data_header(binary):
    """Convert a raw binary into a C header with a const uint8_t array."""
    lines = [
        '#pragma once',
        '#include <cstdint>',
        '',
        'static const uint8_t app_firmware[] __attribute__((aligned(4))) = {',
    ]

    row = []
    for i, byte in enumerate(binary):
        row.append(f'0x{byte:02x}')
        if len(row) == 16:
            lines.append('    ' + ', '.join(row) + ',')
            row = []
    if row:
        lines.append('    ' + ', '.join(row) + ',')

    lines.append('};')
    lines.append(f'static const uint32_t app_firmware_size = {len(binary)};')
    lines.append('')
    return '\n'.join(lines)


# ─── Helpers ──────────────────────────────────────────────────────

def _base_env(board):
    env = os.environ.copy()
    env['LIBDAISY_DIR'] = LIBDAISY_DIR
    env['DAISYSP_DIR'] = DAISYSP_DIR
    env['TARGET'] = board if board else 'patch'
    return env


def _write_sources(tmpdir, files):
    for filename, content in files.items():
        filepath = os.path.join(tmpdir, filename)
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
