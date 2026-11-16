"""Python port of gradeSlice in evals/latent/grade.mjs, kept in step by
rules/latent-conformance.json (the "grader" cases), which the node suite runs
against grade.mjs and test_rule_conformance.py runs against this port.

A slice is correct when its answer and finding labels contain every required group
and its answer contains no forbidden option, and cited when at least one evidence
span overlaps an acceptable span. An option is a string or {"pattern": "..."}, a
case-insensitive JavaScript regular expression.

JavaScript's u-flag regular expressions differ from Python's re in two ways that
matter here: \\d, \\w and \\b are ASCII only (re.ASCII gives the same), while \\s is
Unicode whitespace (re.ASCII would make it ASCII only). So \\s and \\S are rewritten
to the shared whitespace list in rules/latent-rules.json before compiling. A pattern
Python's re cannot compile (variable-width lookbehind, used in evals/latent/fresh.json
renew-on-hold) raises ValueError instead of grading differently.
"""

import re

from latent_pool.rules import QUOTE_SPACE_CODE_POINTS

_SPACES = "".join(re.escape(chr(code)) for code in QUOTE_SPACE_CODE_POINTS)
_FLAGS = re.IGNORECASE | re.ASCII


def _js_string(value):
    return "" if value is None else value if isinstance(value, str) else str(value)


def _python_pattern(pattern):
    """Rewrite JavaScript \\s and \\S (Unicode whitespace) for re with re.ASCII."""
    out = []
    in_class = False
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "\\" and index + 1 < len(pattern):
            escaped = pattern[index + 1]
            if escaped == "s":
                out.append(_SPACES if in_class else "[" + _SPACES + "]")
            elif escaped == "S":
                if in_class:
                    raise ValueError(f"\\S inside a character class is not supported: {pattern!r}")
                out.append("[^" + _SPACES + "]")
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
