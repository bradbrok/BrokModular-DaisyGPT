import re

# Function names that must never appear in user code (directly or via macros)
BLOCKED_FUNCTIONS = [
    'system', 'execl', 'execle', 'execlp', 'execv', 'execve', 'execvp',
    'fork', 'popen', 'fopen', 'freopen',
]

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

    # Token pasting that references blocked functions
    (r'##\s*(' + '|'.join(BLOCKED_FUNCTIONS) + r')\b',
     'Token pasting with blocked function names is not allowed'),
    (r'\b(' + '|'.join(BLOCKED_FUNCTIONS) + r')\s*##',
     'Token pasting with blocked function names is not allowed'),
]

# Regex to match #define lines
_DEFINE_RE = re.compile(r'^\s*#\s*define\b', re.MULTILINE)

# Build a regex matching any blocked function name as a whole word
_BLOCKED_FUNC_RE = re.compile(r'\b(' + '|'.join(BLOCKED_FUNCTIONS) + r')\b')


def _check_patterns(code):
    """Run blocked-pattern checks against code. Returns error message or None."""
    for pattern, message in BLOCKED_PATTERNS:
        if re.search(pattern, code):
            return message
    return None


def _check_defines_for_blocked_names(code):
    """Block #define lines whose body references a blocked function name."""
    for line in code.splitlines():
        stripped = line.strip()
        if not re.match(r'#\s*define\b', stripped):
            continue
        # Extract the body after the macro name (skip #define NAME)
        parts = stripped.split(None, 2)  # ['#define', 'NAME', 'body...'] or with args
        if len(parts) < 3:
            continue
        body = parts[2]
        # If the macro name has parens (function-like macro), body starts after )
        if '(' in parts[1]:
            rest = stripped.split(')', 1)
            body = rest[1] if len(rest) > 1 else ''
        if _BLOCKED_FUNC_RE.search(body):
            return f'#define that references a blocked function is not allowed'
    return None


def _strip_defines(code):
    """Remove all #define lines from code for a second-pass check."""
    lines = code.splitlines()
    result = []
    in_continuation = False
    for line in lines:
        if in_continuation:
            # Multi-line define continuation
            in_continuation = line.rstrip().endswith('\\')
            result.append('')
            continue
        stripped = line.strip()
        if re.match(r'#\s*define\b', stripped):
            in_continuation = stripped.endswith('\\')
            result.append('')
        else:
            result.append(line)
    return '\n'.join(result)


def sanitize_code(code):
    """Check user code for dangerous patterns. Returns error message or None."""
    # Pass 1: Check raw code for blocked patterns
    err = _check_patterns(code)
    if err:
        return err

    # Pass 2: Check if any #define redefines/aliases a blocked function
    err = _check_defines_for_blocked_names(code)
    if err:
        return err

    # Pass 3: Strip #define lines and re-check — catches calls hidden behind macros
    stripped = _strip_defines(code)
    err = _check_patterns(stripped)
    if err:
        return err

    return None
