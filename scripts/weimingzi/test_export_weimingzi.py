"""Regression tests for semantic preservation, routing, selection and non-overwrite."""
import tempfile
import unittest
from pathlib import Path

from export_weimingzi import clean_text, choose_primary, put, record_route, semantic_sequence, heading_text, title_prefix


def doc(did, complete=True, parent=None):
    return {"id": did, "is_complete": complete,
            "inputs": [] if parent is None else [{"role": "derived_from", "target_id": parent}]}


class CleaningTests(unittest.TestCase):
    def test_observed_artifacts_and_whitespace_only(self):
        source = "\ufeff  甲\u200b文  \r\n \t\r\n\r\n乙文\t\r\n"
        result, changes = clean_text(source)
        self.assertEqual(result, "甲文\n\n乙文\n")
        self.assertEqual(changes["removed_zero_width_spaces"], 1)
        self.assertEqual(changes["removed_leading_bom"], 1)
        self.assertEqual(semantic_sequence(source), semantic_sequence(result))

    def test_preserve_brackets_formula_english_and_punctuation(self):
        source = "[from] [is able] a<0 与 a>1；2:30是两分半。don't — ’中文‘。"
        self.assertEqual(clean_text(source)[0], source + "\n")

    def test_cleaning_is_idempotent(self):
        cleaned, _ = clean_text("第一段\n\n第二段。")
        self.assertEqual(clean_text(cleaned)[0], cleaned)

    def test_semantic_zero_width_joiner_is_not_removed(self):
        self.assertEqual(clean_text("👩\u200d💻")[0], "👩\u200d💻\n")

    def test_empty_is_reported_not_fabricated(self):
        for text in ("", " \n\t", "\u200b"):
            with self.assertRaises(ValueError):
                clean_text(text)


class TitleTests(unittest.TestCase):
    def test_distinct_video_and_part_titles(self):
        self.assertEqual(title_prefix({"title": "第二讲"}, {"title": "哲学讲座"}, 2),
                         "# 哲学讲座\n\n## P002：第二讲\n\n")

    def test_same_title_is_not_repeated(self):
        self.assertEqual(title_prefix({"title": "哲学讲座"}, {"title": "哲学讲座"}, 1),
                         "# 哲学讲座\n\n")

    def test_audio_uses_own_title(self):
        self.assertEqual(title_prefix({"title": "神创论"}, {}, None), "# 神创论\n\n")

    def test_heading_is_escaped_and_single_line(self):
        self.assertEqual(heading_text("A*B\n[中文]"), r"A\*B \[中文\]")

    def test_title_prefix_does_not_change_body(self):
        body, _ = clean_text("甲文\n\n英文 a<0 [from]。")
        prefix = title_prefix({"title": "分P"}, {"title": "视频"}, 7)
        rendered = prefix + body
        self.assertEqual(rendered[len(prefix):], body)


class SelectionTests(unittest.TestCase):
    def test_complete_beats_partial_even_if_partial_is_revision(self):
        old = doc("b", True)
        revised_partial = doc("a", False, "b")
        self.assertEqual(choose_primary([revised_partial, old])[0]["id"], "b")

    def test_explicit_revision_beats_id_order(self):
        self.assertEqual(choose_primary([doc("a"), doc("z", parent="a")])[0]["id"], "z")

    def test_transitive_revision_through_partial_ancestor(self):
        self.assertEqual(choose_primary([doc("a"), doc("b", False, "a"), doc("z", True, "b")])[0]["id"], "z")

    def test_unrelated_versions_have_stable_neutral_tiebreak(self):
        self.assertEqual(choose_primary([doc("z"), doc("a")])[0]["id"], "a")
        self.assertEqual(choose_primary([doc("a"), doc("z")])[0]["id"], "a")

    def test_cycles_are_errors(self):
        with self.assertRaises(ValueError):
            choose_primary([doc("a", parent="b"), doc("b", parent="a")])


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.parent_id = "i-" + "1" * 24
        self.item = {"id": "i-" + "2" * 24, "kind": "video_part", "parent_id": self.parent_id,
                     "part_number": 7, "identifiers": {"bilibili_bvid": ["BV1Qv4113798"],
                     "bilibili_part": ["BV1Qv4113798:P7"]}}
        self.items = {self.parent_id: {"id": self.parent_id, "kind": "video", "identifiers": {"bilibili_bvid": ["BV1Qv4113798"]}}}

    def test_real_part_number_preserved(self):
        self.assertEqual(record_route(self.item, self.items)["primary_path"], "by_bv/BV1Qv4113798/P007.md")

    def test_identifier_mismatch_is_error_not_guessed(self):
        self.item["identifiers"]["bilibili_part"] = ["BV1Qv4113798:P1"]
        with self.assertRaises(ValueError):
            record_route(self.item, self.items)

    def test_youtube_has_separate_supplement_not_fake_bv(self):
        self.item["identifiers"] = {"youtube_part": ["GPL8YTWB_hI:P7"]}
        self.items[self.parent_id]["identifiers"] = {"youtube_video": ["GPL8YTWB_hI"]}
        self.assertEqual(record_route(self.item, self.items)["primary_path"], "supplemental/youtube/GPL8YTWB_hI/P007.md")


class WriteTests(unittest.TestCase):
    def test_existing_different_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "a.md"
            put(path, b"original", False)
            put(path, b"original", False)
            with self.assertRaises(ValueError):
                put(path, b"different", False)
            self.assertEqual(path.read_bytes(), b"original")

    def test_verify_only_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing.md"
            with self.assertRaises(ValueError):
                put(path, b"text", True)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
