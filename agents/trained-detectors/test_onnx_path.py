"""ADR-0247: tests for the ONNX inference path's pure parts, the model lock
and the build-time variant selection. No model, no network, no numpy:

    python3 -I -m unittest discover -s agents/trained-detectors -p 'test_*.py'

The export itself (export_onnx.py) needs PyTorch and runs only in the image
build, where its parity check is the gate.
"""

import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import detector_core as core  # noqa: E402
import fetch_models  # noqa: E402

LOCK = json.load(open(os.path.join(HERE, "models.lock.json")))
PERMISSIVE = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"}


class Activations(unittest.TestCase):
    def test_softmax_is_a_distribution_and_stable(self):
        p = core.softmax([1000.0, 1001.0])
        self.assertAlmostEqual(sum(p), 1.0)
        self.assertAlmostEqual(p[1], 1 / (1 + math.exp(-1)))

    def test_sigmoid_is_independent_and_stable(self):
        p = core.sigmoid([-1000.0, 0.0, 1000.0])
        self.assertEqual(p, [0.0, 0.5, 1.0])


class MakeClassifier(unittest.TestCase):
    def test_maps_logits_to_labels(self):
        seen = []

        def encode(text):
            seen.append(text)
            return [1, 2, 3], [1, 1, 1]

        clf = core.make_classifier(encode, lambda ids, mask: [0.0, 2.0], ["benign", "injection"], multi_label=False)
        out = clf("hello")
        self.assertEqual(seen, ["hello"])
        self.assertEqual(set(out), {"benign", "injection"})
        self.assertGreater(out["injection"], 0.88)
        # the injection reducer upper-cases labels, so a lowercase label is found
        self.assertGreater(core.score_injection("hello", clf)["score"], 0.88)

    def test_multi_label_uses_independent_probabilities(self):
        clf = core.make_classifier(lambda t: ([1], [1]), lambda i, m: [5.0, 5.0], ["toxic", "insult"], multi_label=True)
        out = clf("x")
        self.assertGreater(out["toxic"], 0.99)
        self.assertGreater(out["insult"], 0.99)

    def test_a_model_wider_or_narrower_than_its_labels_fails_closed(self):
        clf = core.make_classifier(lambda t: ([1], [1]), lambda i, m: [0.1, 0.2, 0.3], ["benign", "injection"], False)
        with self.assertRaises(ValueError):
            clf("x")


class HarmLabels(unittest.TestCase):
    def test_every_label_is_ours_and_bare(self):
        for theirs, ours in core.HARM_LABELS.items():
            self.assertEqual(core._label(ours), ours)
            self.assertNotEqual(theirs, ours)

    def test_the_label_definitions_document_covers_every_reported_label(self):
        with open(os.path.join(HERE, "HARM_LABELS.md")) as f:
            doc = f.read()
        for ours in set(core.HARM_LABELS.values()):
            self.assertIn(f"`{ours}`", doc)


class ModelLock(unittest.TestCase):
    def test_every_model_is_permissive_and_pinned(self):
        for m in LOCK["models"]:
            self.assertIn(m["licence"], PERMISSIVE, m["repo"])
            self.assertRegex(m["revision"], r"^[0-9a-f]{40}$")
            for sha in m["files"].values():
                self.assertRegex(sha, r"^[0-9a-f]{64}$")

    def test_no_llama_derived_or_custom_code_files(self):
        for m in LOCK["models"]:
            self.assertNotIn("llama", m["repo"].lower())
            self.assertFalse(any(n.endswith(".py") for n in m["files"]), m["repo"])

    def test_every_classifier_has_a_known_export_head(self):
        for m in LOCK["models"]:
            self.assertIn(m["export"]["head"], {"sequence_classification", "deberta_v2_cls_linear"})
            self.assertIsInstance(m["export"]["multiLabel"], bool)


class VariantSelection(unittest.TestCase):
    def test_default_is_piguard_and_each_dir_once(self):
        chosen = fetch_models.selected(LOCK)
        self.assertEqual(sorted(m["dir"] for m in chosen), ["harm", "prompt-injection"])
        self.assertEqual(next(m for m in chosen if m["dir"] == "prompt-injection")["repo"], "leolee99/PIGuard")

    def test_the_alternative_swaps_only_the_injection_model(self):
        chosen = fetch_models.selected(LOCK, "protectai")
        self.assertEqual(
            next(m for m in chosen if m["dir"] == "prompt-injection")["repo"], "protectai/deberta-v3-base-prompt-injection-v2"
        )
        self.assertIn("unitary/toxic-bert", [m["repo"] for m in chosen])

    def test_unknown_variant_and_duplicate_dir_are_refused(self):
        with self.assertRaises(SystemExit):
            fetch_models.selected(LOCK, "llama")
        dup = {"models": [{"dir": "a", "variant": "x"}, {"dir": "a"}]}
        with self.assertRaises(SystemExit):
            fetch_models.selected(dup, "x")


if __name__ == "__main__":
    unittest.main()
