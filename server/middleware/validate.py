MAX_SOURCE_SIZE = 100 * 1024  # 100KB per file
MAX_TOTAL_SIZE = 500 * 1024  # 500KB total for multi-file projects
MAX_FILES = 20  # Maximum number of files in a project

VALID_BOARDS = {'seed', 'patch', 'patch_sm', 'pod', 'petal', 'field'}


def validate_compile_request(request):
    if not request.is_json:
        return 'Content-Type must be application/json'

    data = request.get_json(silent=True)
    if not data:
        return 'Invalid JSON body'

    # Support both single-file (legacy) and multi-file projects
    if 'files' in data:
        files = data['files']
        if not isinstance(files, dict) or not files:
            return 'files must be a non-empty object mapping filenames to content'

        if len(files) > MAX_FILES:
            return f'Too many files (max {MAX_FILES})'

        total_size = 0
        for filename, content in files.items():
            if not isinstance(filename, str) or not isinstance(content, str):
                return 'Each file entry must be a string filename with string content'
            if not content.strip():
                return f'File "{filename}" is empty'
            file_size = len(content.encode('utf-8'))
            if file_size > MAX_SOURCE_SIZE:
                return f'File "{filename}" exceeds maximum size of {MAX_SOURCE_SIZE // 1024}KB'
            total_size += file_size

        if total_size > MAX_TOTAL_SIZE:
            return f'Total project size exceeds maximum of {MAX_TOTAL_SIZE // 1024}KB'

    elif 'code' in data:
        code = data['code']
        if not code or not isinstance(code, str) or not code.strip():
            return 'code must be a non-empty string'
        if len(code.encode('utf-8')) > MAX_SOURCE_SIZE:
            return f'Source code exceeds maximum size of {MAX_SOURCE_SIZE // 1024}KB'

    else:
        return 'Request must include either "code" (string) or "files" (object)'

    target = data.get('target')
    if target is not None and target not in ('flash', 'qspi'):
        return 'target must be "flash" or "qspi"'

    board = data.get('board')
    if board is not None and board not in VALID_BOARDS:
        return f'board must be one of: {", ".join(sorted(VALID_BOARDS))}'

    return None
