"""ADR-0187 B5-M - the one patch the modelscan image carries (decision 107).

modelscan 0.8.8 cannot scan anything when its settings come from a file. Its in-code defaults key
the extension middleware's format map by `Property` objects, and every scanner reads
`format_property.value`. A TOML settings file can only hold string keys, so with `--settings-file`
each scanner raises on `.value` and the whole scan ends as MODEL_SCAN errors with nothing scanned
(measured: an `os.system` pickle exits 3, "nothing scanned", with seven errors). Our settings must
come from a file (G19: a read-only file always passed with --settings-file), so without this patch
the engine could never find anything.

The patch changes ONE function, `FormatViaExtensionMiddleware.__call__`: a format named by a
string in the settings is resolved to modelscan's own `SupportedModelFormats` property of that
value. An unknown name raises, so a typo in the settings fails the scan (an error, which the mapper
reads as unknown) instead of silently disabling a scanner. The rest of the function is unchanged.

The patch refuses to apply unless it finds exactly the code it expects, once, in the installed
0.8.8 file; it is applied at image build time, before the settings are installed.

Usage: python3 -I format-names-from-settings.py <site-packages>/modelscan/middlewares/format_via_extension.py
"""
import sys

EXPECTED = '''        extension = model.get_source().suffix
        formats = [
            format
            for format, extensions in self._settings["formats"].items()
            if extension in extensions
        ]
'''

REPLACEMENT = '''        extension = model.get_source().suffix
        # RegulAIt patch (ADR-0187 decision 107): a settings file names formats by string; resolve each
        # to modelscan's own property, and refuse an unknown name (fail closed)
        from modelscan.settings import SupportedModelFormats

        def _as_property(format):
            if not isinstance(format, str):
                return format
            for prop in vars(SupportedModelFormats).values():
                if getattr(prop, "value", None) == format:
                    return prop
            raise ValueError(f"unknown model format in settings: {format!r}")

        formats = [
            _as_property(format)
            for format, extensions in self._settings["formats"].items()
            if extension in extensions
        ]
'''

MARK = "RegulAIt patch (ADR-0187 decision 107)"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: format-names-from-settings.py <path to format_via_extension.py>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if MARK in src:
        print("refusing: the file is already patched", file=sys.stderr)
        return 1
    if src.count(EXPECTED) != 1:
        print(f"refusing: expected exactly one copy of the code to patch, found {src.count(EXPECTED)}", file=sys.stderr)
        return 1
    with open(path, "w", encoding="utf-8") as f:
        f.write(src.replace(EXPECTED, REPLACEMENT))
    print("patched: format names from a settings file resolve to modelscan's format properties")
    return 0


if __name__ == "__main__":
    sys.exit(main())
