r"""Python port of gradeSlice in evals/latent/grade.mjs, kept in step by
rules/latent-conformance.json (the "grader" cases), which the node suite runs
against grade.mjs and test_rule_conformance.py runs against this port.

A slice is correct when its answer and finding labels contain every required group
and its answer contains no forbidden option, and cited when at least one evidence
span overlaps an acceptable span. An option is a string or {"pattern": "..."}, a
case-insensitive JavaScript regular expression.

JavaScript's iu-flag regular expressions differ from Python's re, so a pattern is
rewritten before compiling (Codex review of H4):
- \d, \w and \b are ASCII classes in JavaScript, but with i they also match the
  characters that case-fold into them (U+017F LONG S, U+212A KELVIN SIGN). Python's
  Unicode IGNORECASE does the same for [0-9A-Za-z_], so they become that class and
  \b and \B become lookarounds on it. re.ASCII is not used: it would also stop
  literal s and k from matching U+017F and U+212A, which JavaScript's i allows.
- \s is Unicode whitespace in JavaScript: it becomes the shared list in
  rules/latent-rules.json.
- $ matches only at the end in JavaScript (no m flag), not before a final newline as
  in Python: it becomes \Z.
A pattern Python's re cannot compile (variable-width lookbehind, used in
evals/latent/fresh.json renew-on-hold) raises ValueError instead of grading
differently, and so do the few constructs this rewrite does not translate.
"""

import re

from latent_pool.rules import QUOTE_SPACE_CODE_POINTS

_SPACES = "".join(re.escape(chr(code)) for code in QUOTE_SPACE_CODE_POINTS)
_FLAGS = re.IGNORECASE


def _js_string(value):
    return "" if value is None else value if isinstance(value, str) else str(value)


_WORD = "0-9A-Za-z_"
_OUTSIDE = {
    "d": "[0-9]", "D": "[^0-9]",
    "w": "[" + _WORD + "]", "W": "[^" + _WORD + "]",
    "s": "[" + _SPACES + "]", "S": "[^" + _SPACES + "]",
    "b": f"(?:(?<=[{_WORD}])(?![{_WORD}])|(?<![{_WORD}])(?=[{_WORD}]))",
    "B": f"(?:(?<=[{_WORD}])(?=[{_WORD}])|(?<![{_WORD}])(?![{_WORD}]))",
}
_INSIDE = {"d": "0-9", "w": _WORD, "s": _SPACES}


def _python_pattern(pattern):
    """Rewrite a JavaScript iu-flag pattern into one Python's re reads the same way."""
    out = []
    in_class = False
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "\\" and index + 1 < len(pattern):
            escaped = pattern[index + 1]
            if in_class and escaped in _INSIDE:
                out.append(_INSIDE[escaped])
            elif in_class and escaped in "DWS":
                raise ValueError(f"\\{escaped} inside a character class is not supported: {pattern!r}")
            elif not in_class and escaped in _OUTSIDE:
                out.append(_OUTSIDE[escaped])
            else:
                out.append(pattern[index:index + 2])
            index += 2
            continue
        if character == "[" and not in_class:
            in_class = True
            out.append(character)
            # A "]" right after "[" or "[^" is a literal in Python but ends the class in
            # JavaScript; no grading pattern uses it, so refuse rather than guess.
            rest = pattern[index + 1:]
            if rest.startswith("]") or rest.startswith("^]"):
                raise ValueError(f"An empty or ']'-first character class is not supported: {pattern!r}")
        elif character == "]" and in_class:
            in_class = False
            out.append(character)
        elif character == "$" and not in_class:
            out.append(r"\Z")
        else:
            out.append(character)
        index += 1
    return "".join(out)


_compiled = {}


def _regex(pattern):
    if pattern not in _compiled:
        try:
            _compiled[pattern] = re.compile(_python_pattern(pattern), _FLAGS)
        except re.error as error:
            raise ValueError(f"Python's re cannot compile this grading pattern ({error}): {pattern!r}") from None
    return _compiled[pattern]


def contains(haystack, option):
    """An option that starts with a digit matches as a whole number; words match as substrings."""
    if isinstance(option, dict):
        return _regex(option["pattern"]).search(haystack) is not None
    needle = option.lower()
    if not re.match(r"[0-9]", needle):
        return needle in haystack
    # No digit (or decimal point) glued on either side; units such as "250ms" are fine.
    return re.search(r"(?<![0-9.])" + re.escape(needle) + r"(?![0-9]|\.[0-9])", haystack) is not None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _overlaps(span, evidence):
    start, end = evidence["lines"]
    begin, finish = span.get("startLine"), span.get("endLine")
    return (span.get("path") == evidence["path"] and _number(begin) and _number(finish)
            and begin <= end and finish >= start)


def grade_slice(question, slice_):
    findings = slice_.get("findings") or []
    haystack = "\n".join([_js_string(slice_.get("answer")), *(_js_string(f.get("label")) for f in findings)]).lower()
    answer = _js_string(slice_.get("answer")).lower()
    correct = (all(any(contains(haystack, option) for option in group) for group in question["required"])
               and not any(contains(answer, option) for option in question.get("forbidden") or []))
    spans = [span for finding in findings for span in (finding.get("evidence") or [])]
    cited = any(_overlaps(span, evidence) for span in spans for evidence in question["evidence"])
    return {"id": question["id"], "correct": correct, "cited": cited}
