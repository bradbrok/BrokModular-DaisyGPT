import os
import re
import time
from flask import Blueprint, request, jsonify, Response

from middleware.validate import validate_compile_request
from middleware.rate_limit import limiter
from services.sanitize import sanitize_code
from services.compiler import compile_code
from services.queue import enqueue, QueueFullError

BOOTLOADER_PATH = '/opt/daisy/libDaisy/core/dsy_bootloader_v6_2-intdfu-2000ms.bin'

compile_bp = Blueprint('compile', __name__)

# Strip internal paths from compiler output
_PATH_PATTERNS = [
    (re.compile(r'/opt/daisy/libDaisy/'), 'libDaisy/'),
    (re.compile(r'/opt/daisy/DaisySP/'), 'DaisySP/'),
    (re.compile(r'/tmp/daisy-build-[a-zA-Z0-9_]+/'), ''),
]


def _scrub_stderr(stderr):
    for pattern, replacement in _PATH_PATTERNS:
        stderr = pattern.sub(replacement, stderr)
    return stderr


@compile_bp.route('/compile', methods=['POST'])
@limiter.limit("10 per 15 minutes")
def compile_endpoint():
    # Validate request
    error = validate_compile_request(request)
    if error:
        return jsonify({'error': 'validation_failed', 'message': error}), 400

    data = request.get_json()
    target = data.get('target', 'flash')
    board = data.get('board', 'patch')

    # Support both single-file (legacy) and multi-file projects
    if 'files' in data and isinstance(data['files'], dict):
        files = data['files']
    elif 'code' in data:
        files = {'main.cpp': data['code']}
    else:
        return jsonify({'error': 'validation_failed', 'message': 'Missing code or files'}), 400

    # Sanitize all files
    for filename, code in files.items():
        rejection = sanitize_code(code)
        if rejection:
            return jsonify({'error': 'code_rejected', 'message': f'{filename}: {rejection}'}), 400

    # Enqueue compilation
    try:
        start = time.time()
        result = enqueue(lambda: compile_code(files, target, board))
        elapsed = time.time() - start
    except QueueFullError:
        return jsonify({'error': 'queue_full', 'message': 'Server busy, try again shortly'}), 429, {
            'Retry-After': '15'
        }
    except TimeoutError as e:
        return jsonify({'error': 'compilation_timeout', 'message': str(e)}), 422
    except RuntimeError as e:
        error_info = str(e)
        parts = error_info.split('|||', 1)
        stderr = parts[1] if len(parts) > 1 else error_info
        return jsonify({
            'error': 'compilation_failed',
            'stderr': _scrub_stderr(stderr),
            'exit_code': 1
        }), 422

    binary_data, target_address = result

    return Response(
        binary_data,
        mimetype='application/octet-stream',
        headers={
            'X-Compile-Time': f'{elapsed:.2f}',
            'X-Binary-Size': str(len(binary_data)),
            'X-Target-Address': target_address,
        }
    )


@compile_bp.route('/bootloader', methods=['GET'])
@limiter.limit("10 per 15 minutes")
def bootloader_endpoint():
    if not os.path.exists(BOOTLOADER_PATH):
        return jsonify({'error': 'not_found', 'message': 'Bootloader binary not found'}), 404

    with open(BOOTLOADER_PATH, 'rb') as f:
        binary_data = f.read()

    return Response(
        binary_data,
        mimetype='application/octet-stream',
        headers={
            'X-Binary-Size': str(len(binary_data)),
            'Content-Disposition': 'attachment; filename="dsy_bootloader.bin"',
        }
    )
