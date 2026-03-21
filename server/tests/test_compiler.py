"""Tests for _write_sources() path traversal fixes."""
import os
import sys
import tempfile
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.compiler import _write_sources


class TestWriteSourcesPathTraversal:
    def test_dotdot_filename_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(ValueError, match='Invalid filename'):
                _write_sources(tmpdir, {'../escape.cpp': 'int main() {}'})

    def test_absolute_filename_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(ValueError, match='Invalid filename'):
                _write_sources(tmpdir, {'/etc/passwd': 'bad content'})

    def test_dotdot_in_nested_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(ValueError, match='Invalid filename'):
                _write_sources(tmpdir, {'subdir/../../escape.cpp': 'int main() {}'})

    def test_special_chars_in_filename_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(ValueError, match='Invalid filename'):
                _write_sources(tmpdir, {'file;rm -rf /.cpp': 'bad'})

    def test_valid_simple_filename_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_sources(tmpdir, {'main.cpp': 'int main() { return 0; }'})
            assert os.path.exists(os.path.join(tmpdir, 'main.cpp'))

    def test_valid_nested_filename_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_sources(tmpdir, {'src/module.cpp': 'void foo() {}'})
            assert os.path.exists(os.path.join(tmpdir, 'src', 'module.cpp'))

    def test_valid_filename_with_dashes_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_sources(tmpdir, {'my-module_v2.cpp': 'void bar() {}'})
            assert os.path.exists(os.path.join(tmpdir, 'my-module_v2.cpp'))

    def test_multiple_valid_files_pass(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            files = {
                'main.cpp': 'int main() {}',
                'util.h': 'void util();',
                'src/dsp.cpp': 'void dsp() {}',
            }
            _write_sources(tmpdir, files)
            assert os.path.exists(os.path.join(tmpdir, 'main.cpp'))
            assert os.path.exists(os.path.join(tmpdir, 'util.h'))
            assert os.path.exists(os.path.join(tmpdir, 'src', 'dsp.cpp'))
