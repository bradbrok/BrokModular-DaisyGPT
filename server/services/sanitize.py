import re

# Allowlist of permitted #include headers.
# Only Daisy ecosystem and standard embedded C/C++ headers are allowed.
ALLOWED_INCLUDES = {
    # Daisy
    'daisy.h', 'daisy_seed.h', 'daisy_patch.h', 'daisy_patch_sm.h',
    'daisy_pod.h', 'daisy_petal.h', 'daisy_field.h', 'daisy_versio.h',
    'daisy_legio.h',
    # DaisySP
    'daisysp.h',
    # C standard (embedded-safe subset)
    'stdint.h', 'stdbool.h', 'stddef.h', 'stdlib.h', 'string.h',
    'math.h', 'float.h', 'limits.h', 'ctype.h', 'errno.h',
    'assert.h', 'stdarg.h', 'inttypes.h',
    # C++ standard (embedded-safe subset)
    'cstdint', 'cstddef', 'cstdlib', 'cstring', 'cmath',
    'cfloat', 'climits', 'cstdarg', 'algorithm', 'array',
    'type_traits', 'utility', 'functional', 'numeric', 'iterator',
    'initializer_list', 'tuple', 'limits', 'new', 'memory',
    # ARM CMSIS DSP (often used in audio)
    'arm_math.h',
}

# Regex to extract all #include directives
INCLUDE_RE = re.compile(r'#\s*include\s*[<"]([^>"]+)[>"]')


ALLOWED_PREFIXES = (
    'Source/', 'DaisySP/', 'Utility/', 'Control/', 'Drums/',
    'Effects/', 'Filters/', 'Noise/', 'PhysicalModeling/', 'Synthesis/',
)


def sanitize_code(code):
    includes = INCLUDE_RE.findall(code)
    for inc in includes:
        # Allow DaisySP subdirectory includes like "Synthesis/oscillator.h"
        basename = inc.split('/')[-1] if '/' in inc else inc
        # Anchor DaisySP subpaths to known prefixes; reject any '..' components
        is_daisysp_sub = (
            inc.endswith('.h') and
            '..' not in inc and
            any(inc.startswith(prefix) or f'/{prefix}' in inc for prefix in ALLOWED_PREFIXES)
        )

        if basename not in ALLOWED_INCLUDES and not is_daisysp_sub:
            return f'#include "{inc}" is not permitted. Only Daisy/DaisySP and standard embedded headers are allowed.'

    return None
