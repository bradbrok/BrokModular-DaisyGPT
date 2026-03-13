import time
from flask import Blueprint, request, jsonify, Response

from middleware.validate import validate_compile_request
from middleware.rate_limit import limiter
from services.sanitize import sanitize_code
from services.compiler import compile_code
from services.queue import enqueue, QueueFullError

compile_bp = Blueprint('compile', __name__)


@compile_bp.route('/compile', methods=['POST'])
@limiter.limit("10 per 15 minutes")
def compile_endpoint():
    # Validate request
    error = validate_compile_request(request)
    if error:
        return jsonify({'error': 'validation_failed', 'message': error}), 400

    data = request.get_json()
    code = data['code']
    target = data.get('target', 'flash')

    # Sanitize code
    rejection = sanitize_code(code)
    if rejection:
        return jsonify({'error': 'code_rejected', 'message': rejection}), 400

    # Enqueue compilation
    try:
        start = time.time()
        result = enqueue(lambda: compile_code(code, target))
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
            'stderr': stderr,
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
