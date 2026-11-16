"""Rule data shared with the ledger: rules/latent-rules.json at the repository root.

The ledger (src/latent.mjs) imports the same file, so the secret-file lists and the
whitespace that quotes fold are defined once for both languages. The runtime runs
from runtime/ inside a repository checkout (LATENT_ROOT may point anywhere else), so
the file is found relative to this module, not to the working directory.
"""

import json
from pathlib import Path

RULES_PATH = Path(__file__).resolve().parents[2] / "rules" / "latent-rules.json"


def _load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise RuntimeError(
            f"Shared rule file not found: {path}. The latent runtime must run from runtime/ "
            "inside a context-ledger checkout, which has rules/latent-rules.json.") from None
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Shared rule file cannot be read: {path}: {error}") from None


def _strings(section, key):
    value = section.get(key) if isinstance(section, dict) else None
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise RuntimeError(f"{RULES_PATH}: {key} must be a list of non-empty strings.")
    return value


def parse_code_points(entries):
    """["0009-000D", "0020"] -> [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20]; ranges are inclusive."""
    codes = []
    for entry in entries:
        low, _, high = entry.partition("-")
        try:
            start, end = int(low, 16), int(high or low, 16)
        except ValueError:
            raise RuntimeError(f"{RULES_PATH}: bad code point entry {entry!r}.") from None
        if not 0 <= start <= end <= 0x10FFFF:
            raise RuntimeError(f"{RULES_PATH}: bad code point entry {entry!r}.")
        codes.extend(range(start, end + 1))
    return tuple(codes)


RULES = _load(RULES_PATH)
_secret = RULES.get("secretPaths") if isinstance(RULES, dict) else None
SECRET_DIRS = frozenset(_strings(_secret, "dirs"))
SECRET_NAMES = frozenset(_strings(_secret, "names"))
SECRET_PREFIXES = tuple(_strings(_secret, "prefixes"))
SECRET_SUFFIXES = tuple(_strings(_secret, "suffixes"))
ENV_TEMPLATES = frozenset(_strings(_secret, "templates"))
QUOTE_SPACE_CODE_POINTS = parse_code_points(
    _strings(RULES.get("quoteWhitespace") if isinstance(RULES, dict) else None, "codePoints"))
