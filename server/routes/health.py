from flask import Blueprint, jsonify
from services.queue import get_queue_status

health_bp = Blueprint('health', __name__)


@health_bp.route('/health', methods=['GET'])
def health():
    status = get_queue_status()
    return jsonify({
        'status': 'ok',
        'queue': status
    })
