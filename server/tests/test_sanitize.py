"""Tests for sanitize_code() path traversal fixes."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.sanitize import sanitize_code


class TestSanitizePathTraversal:
    def test_dotdot_in_include_is_rejected(self):
        code = '#include "../../etc/passwd"'
        result = sanitize_code(code)
        assert result is not None
        assert 'not permitted' in result

    def test_dotdot_in_daisysp_subpath_is_rejected(self):
        """A '..' inside an otherwise-valid DaisySP-prefix path must be rejected."""
        code = '#include "Synthesis/../../etc/shadow.h"'
        result = sanitize_code(code)
        assert result is not None
        assert 'not permitted' in result

    def test_unknown_prefix_subpath_is_rejected(self):
        """A multi-segment path without a known prefix should be rejected."""
        code = '#include "unknown/module.h"'
        result = sanitize_code(code)
        assert result is not None
        assert 'not permitted' in result

    def test_valid_synthesis_include_passes(self):
        code = '#include "Synthesis/oscillator.h"'
        result = sanitize_code(code)
        assert result is None

    def test_valid_effects_include_passes(self):
        code = '#include "Effects/reverbsc.h"'
        result = sanitize_code(code)
        assert result is None

    def test_valid_filters_include_passes(self):
        code = '#include "Filters/svf.h"'
        result = sanitize_code(code)
        assert result is None

    def test_valid_utility_include_passes(self):
        code = '#include "Utility/dsp.h"'
        result = sanitize_code(code)
        assert result is None

    def test_allowed_top_level_include_passes(self):
        code = '#include "daisy_seed.h"'
        result = sanitize_code(code)
        assert result is None

    def test_stdlib_include_passes(self):
        code = '#include <stdint.h>'
        result = sanitize_code(code)
        assert result is None

    def test_clean_code_returns_none(self):
        code = '#include "daisy_patch.h"\n#include "Synthesis/oscillator.h"\nint main() {}'
        result = sanitize_code(code)
        assert result is None
