MAX_SOURCE_SIZE = 100 * 1024  # 100KB


def validate_compile_request(request):
    if not request.is_json:
        return 'Content-Type must be application/json'

    data = request.get_json(silent=True)
    if not data:
        return 'Invalid JSON body'

    code = data.get('code')
    if not code or not isinstance(code, str) or not code.strip():
        return 'code must be a non-empty string'

    if len(code.encode('utf-8')) > MAX_SOURCE_SIZE:
        return f'Source code exceeds maximum size of {MAX_SOURCE_SIZE // 1024}KB'

    target = data.get('target')
    if target is not None and target not in ('flash', 'qspi'):
        return 'target must be "flash" or "qspi"'

    return None
