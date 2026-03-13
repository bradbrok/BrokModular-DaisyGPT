import re

# Patterns that indicate potentially dangerous code
BLOCKED_PATTERNS = [
    # System calls
    (r'\bsystem\s*\(', 'system() calls are not allowed'),
    (r'\bexecv?[lp]?e?\s*\(', 'exec*() calls are not allowed'),
    (r'\bfork\s*\(', 'fork() is not allowed'),
    (r'\bpopen\s*\(', 'popen() is not allowed'),

    # Dangerous headers
    (r'#\s*include\s*<\s*unistd\.h\s*>', '#include <unistd.h> is not allowed'),
    (r'#\s*include\s*<\s*sys/', '#include <sys/*> headers are not allowed'),
    (r'#\s*include\s*<\s*spawn\.h\s*>', '#include <spawn.h> is not allowed'),
    (r'#\s*include\s*<\s*dlfcn\.h\s*>', '#include <dlfcn.h> is not allowed'),

    # Inline assembly
    (r'\b__asm__\b', 'Inline assembly (__asm__) is not allowed'),
    (r'\basm\s*\(', 'Inline assembly (asm()) is not allowed'),

    # File I/O
    (r'\bfopen\s*\(', 'fopen() is not allowed'),
    (r'\bfreopen\s*\(', 'freopen() is not allowed'),

    # Preprocessor tricks
    (r'#\s*pragma\s+comment\s*\(\s*lib', '#pragma comment(lib) is not allowed'),
]


def sanitize_code(code):
    for pattern, message in BLOCKED_PATTERNS:
        if re.search(pattern, code):
            return message
    return None
