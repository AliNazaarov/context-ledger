"""H4: the runtime decides the shared rule cases exactly as the ledger does.

rules/latent-rules.json holds the rule data both languages read, and
rules/latent-conformance.json the cases that this file and the node suite
(tests/latent-rules.test.mjs) both run. A rule changed in one language only fails
one of the two suites.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from latent_pool import ApiError, pool, rules
from latent_pool.prefix import check_path_syntax, is_secret_path
from tests.grade import grade_slice

REPO = Path(__file__).resolve().parents[2]
RUNTIME = REPO / "runtime"


def load(relative):
    with open(REPO / relative, encoding="utf-8") as handle:
        return json.load(handle)


CASES = load("rules/latent-conformance.json")
_question_files = {}


def question_of(entry):
    if "question" in entry:
        return entry["question"]
    ref = entry["questionRef"]
    if ref["file"] not in _question_files:
        _question_files[ref["file"]] = load(ref["file"])
    [question] = [q for q in _question_files[ref["file"]]["questions"] if q["id"] == ref["id"]]
    return question


class SharedRuleFileTest(unittest.TestCase):
    def test_the_runtime_reads_the_rule_file_at_the_repository_root(self):
        self.assertEqual(rules.RULES_PATH, REPO / "rules" / "latent-rules.json")
        self.assertEqual(rules.RULES, load("rules/latent-rules.json"))
        self.assertEqual(sorted(rules.SECRET_DIRS), sorted(rules.RULES["secretPaths"]["dirs"]))

    def test_a_missing_rule_file_fails_loudly(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "latent-rules.json"
            with self.assertRaises(RuntimeError) as caught:
                rules._load(missing)
            self.assertIn("Shared rule file not found", str(caught.exception))
            self.assertIn(str(missing), str(caught.exception))
            missing.write_text("{", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                rules._load(missing)

    def test_the_rule_file_is_found_from_any_working_directory(self):
        # The runtime is started from runtime/ with LATENT_ROOT elsewhere; the rule file
        # must not depend on the working directory.
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "PYTHONPATH": str(RUNTIME), "LATENT_ROOT": directory}
            code = "from latent_pool import prefix; print(prefix.is_secret_path(['.env']))"
            result = subprocess.run([sys.executable, "-c", code], cwd=directory, env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "True")

    def test_code_point_entries_are_hex_or_inclusive_ranges(self):
        self.assertEqual(rules.parse_code_points(["0009-000B", "0020"]), (0x09, 0x0A, 0x0B, 0x20))
        for bad in (["zz"], ["0020-0010"], ["110000"]):
            with self.assertRaises(RuntimeError):
                rules.parse_code_points(bad)


class SecretRuleConformanceTest(unittest.TestCase):
    def test_every_shared_case(self):
        self.assertGreaterEqual(len(CASES["secretPaths"]), 30)
        for case in CASES["secretPaths"]:
            path = case["path"]
            self.assertEqual(is_secret_path(path.split("/")), case["secret"], path)
            if case["secret"]:
                with self.assertRaises(ApiError) as caught:
                    check_path_syntax(path)
                self.assertEqual(caught.exception.status, 400, path)
                self.assertIn("secret files", caught.exception.message, path)
            else:
                self.assertEqual(check_path_syntax(path), path.split("/"))


class WhitespaceConformanceTest(unittest.TestCase):
    def test_every_shared_case(self):
        for case in CASES["quoteWhitespace"]:
            self.assertEqual(pool.fold_space(case["text"]), case["folded"], repr(case["text"]))

    def test_the_quote_enum_folds_lines_with_the_shared_list(self):
        files = [("a.js", [case["text"] for case in CASES["quoteWhitespace"]])]
        expected = list(dict.fromkeys(case["folded"] for case in CASES["quoteWhitespace"] if case["folded"]))
        self.assertEqual(pool.quotable_lines(files), expected)


class GraderConformanceTest(unittest.TestCase):
    def test_every_shared_graded_answer(self):
        self.assertGreaterEqual(len(CASES["grader"]), 20)
        for case in CASES["grader"]:
            question = question_of(case)
            result = grade_slice(question, case["slice"])
            self.assertEqual({"correct": result["correct"], "cited": result["cited"]}, case["expected"],
                             f"{question['id']}: {case['slice']!r}")

    def test_questions_only_javascript_can_grade_are_refused_not_misgraded(self):
        for case in CASES["graderJavaScriptOnly"]:
            with self.assertRaises(ValueError):
                grade_slice(question_of(case), {"answer": "The renewal is rejected; it succeeds."})


if __name__ == "__main__":
    unittest.main()
