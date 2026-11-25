"""Offline privacy regressions using synthetic release packages and a stub SDK."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

import publish_modelscope as publish


class PublishPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.temporary = tempfile.TemporaryDirectory(prefix="publish-privacy-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.counter = 0
        self.root = self.package()
        self.remote_events = []

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")

    def package(self):
        self.counter += 1
        root = self.base / f"release-{self.counter}"
        cot = {"messages": [{"role": "user", "content": "问题"},
                            {"role": "assistant", "content": "<think>先检查。</think>回答。"}]}
        evaluation = {"difficulty": "hard", "expectedBehavior": "answer", "itemKey": "probe:1",
                      "messages": [{"role": "user", "content": r"比较 $x \neq y$ 与 $\frac{a}{b}$。"},
                                   {"role": "assistant", "content": "说明差异。"}],
                      "persona": "学者", "probeType": "adversarial", "rubrics": {"criteria": "准确"},
                      "videoKey": "BV1fixture"}
        for rel in publish.RELEASE_FILES:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if rel.endswith(".jsonl"):
                self.write_json(path, cot if "cot_sft" in rel else evaluation)
            elif rel.endswith(".json"):
                self.write_json(path, {})
            else:
                path.write_text("Synthetic package <your-namespace>/<dataset-name>\n", encoding="utf-8")
        self.rehash(root)
        return root

    def rehash(self, root=None):
        root = root or self.root
        for manifest, mappings in (
            ("manifests/cot-sft-manifest.json", {"outSha256": "data/cot_sft/train.jsonl", "valSha256": "data/cot_sft/val.jsonl"}),
            ("manifests/adv-main-v1.manifest.json", {"sha256": "data/eval/adv-main-v1.jsonl"}),
            ("manifests/trap-main-v1.manifest.json", {"sha256": "data/eval/trap-main-v1.jsonl"}),
        ):
            value = json.loads((root / manifest).read_text(encoding="utf-8"))
            value.update({key: publish.sha256_file(root / rel) for key, rel in mappings.items()})
            self.write_json(root / manifest, value)
        sums = "".join(f"{publish.sha256_file(root / rel)}  {rel}\n" for rel in publish.CHECKSUM_FILES)
        (root / publish.RELEASE_FILES[-1]).write_text(sums, encoding="utf-8")

    def inject(self, root, rel, value):
        path = root / rel
        if rel.endswith(".jsonl"):
            obj = json.loads(path.read_text(encoding="utf-8"))
            obj["messages"][1]["content"] = "<think>检查。</think>" + value
            self.write_json(path, obj)
        elif rel.endswith(".json"):
            obj = json.loads(path.read_text(encoding="utf-8"))
            obj["description"] = value
            self.write_json(path, obj)
        else:
            path.write_text(value + "\n", encoding="utf-8")
        if rel != publish.RELEASE_FILES[-1]:
            self.rehash(root)

    def args(self, root=None, *, dry_run=False, review=None):
        argv = ["upload", "--repo-id", "fixture/dataset", "--release-dir", str(root or self.root),
                "--token", "fixture-upload-key", "--create"]
        if dry_run:
            argv.append("--dry-run")
        if review:
            argv.extend(["--privacy-review", str(review)])
        return publish.build_parser().parse_args(argv)

    def sdk(self):
        parent = self

        class HubApi:
            def __init__(self, **kwargs):
                parent.remote_events.append("construct")

            def create_repo(self, **kwargs):
                parent.remote_events.append("create")

            def upload_folder(self, **kwargs):
                root = Path(kwargs["folder_path"])
                files = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
                parent.remote_events.append({"files": files, "root": root, "ignore": kwargs["ignore_patterns"],
                                             "readme": (root / "README.md").read_text(encoding="utf-8")})

        api = types.ModuleType("modelscope_hub.api")
        api.HubApi = HubApi
        errors = types.ModuleType("modelscope_hub.errors")
        errors.AlreadyExistsError = type("AlreadyExistsError", (Exception,), {})
        return mock.patch.dict("sys.modules", {"modelscope_hub": types.ModuleType("modelscope_hub"),
                                               "modelscope_hub.api": api, "modelscope_hub.errors": errors})

    def approval(self, root, *, rel="README.md", field="$", category="email", line=1, value=None, reason="Public contact reviewed"):
        if value is None:
            value = (root / rel).read_text(encoding="utf-8").splitlines()[line - 1]
        return {"file": rel, "line": line, "field": field, "category": category,
                "sha256": publish.value_fingerprint(value), "reason": reason}

    def review(self, approval, name="review.json"):
        path = self.base / name
        self.write_json(path, {"version": 1, "approvals": [approval]})
        return path

    def test_normal_package_and_latex_pass(self):
        files = publish.validate_release(self.root)
        self.assertEqual([p.relative_to(self.root).as_posix() for p in files], list(publish.RELEASE_FILES))
        publish.scan_string("123138001380001234 x13800138000y relative/path 23191782", "README.md", 1, "$", set(), ())

    def test_sensitive_values_in_all_nine_files_are_blocked_without_echo(self):
        secret = "sk-" + "synthetic" * 5
        for rel in publish.RELEASE_FILES:
            with self.subTest(file=rel):
                root = self.package()
                self.inject(root, rel, secret)
                with self.assertRaises(publish.ReleaseValidationError) as caught:
                    publish.validate_release(root)
                self.assertNotIn(secret, str(caught.exception))
                self.assertNotIn(str(self.base), str(caught.exception))
                self.assertIn(rel, str(caught.exception))

    def test_patterns_paths_and_configured_secrets(self):
        body = "11010120000101001"
        weights = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
        identifier = body + "10X98765432"[sum(int(n) * w for n, w in zip(body, weights)) % 11]
        values = ["-----BEGIN PRIVATE KEY-----", "ghp_" + "b" * 32, "AKIA" + "A" * 16,
                  "fixture@example.test", "+86 13800138000", identifier,
                  "/Users/fixture/private.txt", "/home/fixture/private.txt", r"D:\project\private.txt",
                  r"\\fixture-server\share\private.txt", "nonstandard-explicit-key"]
        for value in values:
            with self.subTest(category=value[:6]):
                root = self.package()
                self.inject(root, "data/cot_sft/train.jsonl", value)
                with self.assertRaises(publish.ReleaseValidationError) as caught:
                    publish.validate_release(root, secrets=("nonstandard-explicit-key",))
                self.assertNotIn(value, str(caught.exception))
        # Invalid dates/check digits are not valid identity numbers.
        publish.scan_string("110101200013010019 110101200001010012", "README.md", 1, "$", set(), ())

    def test_numeric_pii_including_exact_float_literals_is_blocked(self):
        # The identity uses a synthetic date/sequence and a valid check digit.
        identifier = "110101200001010010"
        literals = ("13800138000", "13800138000.0", "1.3800138000e10", identifier,
                    identifier + ".0", identifier[0] + "." + identifier[1:] + "e17")
        rel = "manifests/adv-main-v1.manifest.json"
        for literal in literals:
            with self.subTest(literal_type="exponent" if "e" in literal else "decimal"):
                root = self.package()
                path = root / rel
                obj = json.loads(path.read_text(encoding="utf-8"))
                obj["metadata"] = "numeric-fixture-placeholder"
                text = json.dumps(obj).replace('"numeric-fixture-placeholder"', literal)
                path.write_text(text, encoding="utf-8")
                with self.assertRaises(publish.ReleaseValidationError) as caught:
                    publish.validate_release(root)
                self.assertIn("$.metadata", str(caught.exception))
                self.assertIn("cn_id" if literal.startswith("110") or literal.startswith("1.101") else "cn_mobile",
                              str(caught.exception))
                self.assertNotIn(literal, str(caught.exception))
        with self.assertRaises(publish.ReleaseValidationError):
            publish.scan_value(13800138000.0, "README.md", 1, "$", set(), ())

    def test_numeric_reviews_use_canonical_integer_and_reject_changed_values(self):
        rel = "manifests/adv-main-v1.manifest.json"
        path = self.root / rel
        obj = json.loads(path.read_text(encoding="utf-8"))
        obj["metadata"] = 13800138000
        self.write_json(path, obj)
        self.rehash()
        approval = self.approval(self.root, rel=rel, field="$.metadata", category="cn_mobile", value="13800138000")
        review = self.review(approval)
        publish.validate_release(self.root, review_path=str(review))
        obj["metadata"] = 13800138001
        self.write_json(path, obj)
        self.rehash()
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))
        # Ordinary short IDs, long digit sequences and booleans remain ordinary metadata.
        obj["metadata"] = [True, False, None, 23191782, 123138001380001234, 123456789012345678, 0.5]
        self.write_json(path, obj)
        self.rehash()
        publish.validate_release(self.root)

    def test_configured_keys_and_arg_token_are_stripped_before_scanning(self):
        key = "nonstandard-fixture-key"
        token = "nonstandard-fixture-token"
        args = self.args()
        args.token = "  " + token + "  "
        with mock.patch.dict(os.environ, {"LLM_API_KEY": "  " + key + "  ", "EVAL_LLM_API_KEY": " EMPTY "}):
            self.assertEqual(set(publish.configured_secrets(args)), {key, token})
            for secret in (key, token):
                root = self.package()
                (root / "README.md").write_text(secret, encoding="utf-8")
                args.release_dir = str(root)
                with self.sdk(), self.assertRaises(publish.ReleaseValidationError) as caught:
                    publish.cmd_upload(args)
                self.assertIn("configured_secret", str(caught.exception))
                self.assertNotIn(secret, str(caught.exception))
            self.assertEqual(self.remote_events, [])

    def test_explicit_auth_fields_block_short_and_numeric_values(self):
        rel = "manifests/adv-main-v1.manifest.json"
        names = ("api_key", "Authorization", "passw" + "ord", "token", "client_secret")
        for key in names:
            for value in ("x", "  abc  ", 7, 0, {"value": "short"}):
                root = self.package()
                path = root / rel
                obj = json.loads(path.read_text(encoding="utf-8"))
                obj["metadata"] = {key: value}
                self.write_json(path, obj)
                with self.assertRaises(publish.ReleaseValidationError) as caught:
                    publish.validate_release(root)
                self.assertIn("credential_field", str(caught.exception))
        for value in (None, False, True, "", "  ", "EMPTY", " replace-with-your-key "):
            publish.scan_value({"api_key": value}, rel, 1, "$", set(), ())

    def test_pii_review_is_precise_and_value_changes_invalidate_it(self):
        self.inject(self.root, "README.md", "contact fixture@example.test")
        review = self.review(self.approval(self.root))
        publish.validate_release(self.root, review_path=str(review))
        (self.root / "README.md").write_text("changed contact fixture@example.test\n", encoding="utf-8")
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))

    def test_review_matches_json_field_and_whole_decoded_value(self):
        rel = "data/cot_sft/train.jsonl"
        self.inject(self.root, rel, "fixture@example.test")
        value = json.loads((self.root / rel).read_text(encoding="utf-8"))["messages"][1]["content"]
        approval = self.approval(self.root, rel=rel, field="$.messages[1].content", value=value)
        review = self.review(approval)
        publish.validate_release(self.root, review_path=str(review))
        for key, bad in (("line", 2), ("field", "$.messages[0].content"), ("file", "data/cot_sft/val.jsonl")):
            with self.subTest(key=key):
                modified = {**approval, key: bad}
                self.write_json(review, {"version": 1, "approvals": [modified]})
                with self.assertRaises(publish.ReleaseValidationError):
                    publish.validate_release(self.root, review_path=str(review))

    def test_review_requires_reason_and_never_approves_credentials(self):
        for reason in ("", "short"):
            review = self.review(self.approval(self.root, reason=reason))
            with self.assertRaises(publish.ReleaseValidationError):
                publish.validate_release(self.root, review_path=str(review))
        review = self.review(self.approval(self.root, category="credential"))
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))
        secret = "sk-" + "x" * 32
        self.inject(self.root, "README.md", "fixture@example.test " + secret)
        review = self.review(self.approval(self.root))
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))

    def test_review_must_stay_outside_package(self):
        review = self.root / "review.json"
        self.write_json(review, {"version": 1, "approvals": []})
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))
        (self.root / "review.json").unlink()
        review = self.root / publish.CACHE_NAME
        self.write_json(review, {"version": 1, "approvals": []})
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root, review_path=str(review))

    def test_extra_files_directories_and_secret_filenames_are_not_echoed(self):
        for name in (".env", "backup.sqlite", "backup.json", "sk-" + "a" * 40):
            root = self.package()
            (root / name).write_text("synthetic", encoding="utf-8")
            with self.assertRaises(publish.ReleaseValidationError) as caught:
                publish.validate_release(root)
            self.assertNotIn(name, str(caught.exception))
        root = self.package()
        (root / "extra-empty-directory").mkdir()
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(root)

    def test_links_in_required_files_ancestors_cache_and_root_are_blocked(self):
        probe = self.base / "link-probe"
        try:
            probe.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("OS account cannot create synthetic symbolic links")
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(probe)
        for rel in ("README.md", "data/cot_sft", publish.CACHE_NAME):
            with self.subTest(rel=rel):
                root = self.package()
                path = root / rel
                target = self.base / ("outside-" + str(self.counter))
                if path.is_dir():
                    path.rename(target)
                    path.symlink_to(target, target_is_directory=True)
                else:
                    target.write_text("outside", encoding="utf-8")
                    if path.exists():
                        path.unlink()
                    path.symlink_to(target)
                with self.assertRaises(publish.ReleaseValidationError):
                    publish.validate_release(root)

    def test_hard_link_and_windows_junction_flags_are_blocked(self):
        target = self.root / "README.md"
        other = self.base / "hard-linked-card"
        try:
            os.link(target, other)
        except OSError:
            self.skipTest("Hard links unavailable")
        with self.assertRaises(publish.ReleaseValidationError):
            publish.validate_release(self.root)
        fake = types.SimpleNamespace(st_mode=0o40755, st_file_attributes=0x400)
        with mock.patch.object(Path, "lstat", return_value=fake):
            self.assertTrue(publish.is_link(self.root))

    def test_cache_is_local_only_and_upload_uses_private_nine_file_snapshot(self):
        (self.root / publish.CACHE_NAME).write_text("local cache synthetic key", encoding="utf-8")
        before = (self.root / "README.md").read_bytes()
        with self.sdk(), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(publish.cmd_upload(self.args()), 0)
        event = self.remote_events[-1]
        self.assertEqual(event["files"], sorted(publish.RELEASE_FILES))
        self.assertNotEqual(event["root"], self.root)
        self.assertFalse(event["root"].exists())
        self.assertIn(publish.CACHE_NAME, event["ignore"])
        self.assertIn("fixture/dataset", event["readme"])
        self.assertEqual((self.root / "README.md").read_bytes(), before)
        (self.root / publish.CACHE_NAME).unlink()
        (self.root / publish.CACHE_NAME).mkdir()
        (self.root / publish.CACHE_NAME / "state").write_text("local only", encoding="utf-8")
        self.assertEqual(len(publish.validate_release(self.root)), 9)

    def test_dry_run_is_read_only_and_never_constructs_sdk(self):
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        with self.sdk(), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(publish.cmd_upload(self.args(dry_run=True)), 0)
        self.assertEqual(self.remote_events, [])
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before})

    def test_upload_without_prepare_revalidates_schema_hashes_and_content(self):
        mutations = ("schema", "manifest", "sums", "content", "extra")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                root = self.package()
                if mutation == "schema":
                    self.write_json(root / "data/cot_sft/train.jsonl", {"messages": []})
                    self.rehash(root)
                elif mutation == "manifest":
                    manifest = root / "manifests/adv-main-v1.manifest.json"
                    obj = json.loads(manifest.read_text(encoding="utf-8"))
                    obj["sha256"] = "0" * 64
                    self.write_json(manifest, obj)
                elif mutation == "sums":
                    (root / publish.RELEASE_FILES[-1]).write_text("0" * 64 + "  README.md\n", encoding="utf-8")
                elif mutation == "content":
                    path = root / "data/cot_sft/train.jsonl"
                    path.write_text(path.read_text(encoding="utf-8").replace("回答", "改动"), encoding="utf-8")
                else:
                    (root / "backup.txt").write_text("extra", encoding="utf-8")
                with self.sdk(), self.assertRaises(publish.ReleaseValidationError):
                    publish.cmd_upload(self.args(root))
                self.assertEqual(self.remote_events, [])

    def prepare_args(self, target):
        return publish.build_parser().parse_args([
            "prepare", "--release-dir", str(target),
            "--cot-train", str(self.root / "data/cot_sft/train.jsonl"),
            "--cot-val", str(self.root / "data/cot_sft/val.jsonl"),
            "--cot-manifest", str(self.root / "manifests/cot-sft-manifest.json"),
            "--eval-adv", str(self.root / "data/eval/adv-main-v1.jsonl"),
            "--eval-adv-manifest", str(self.root / "manifests/adv-main-v1.manifest.json"),
            "--eval-trap", str(self.root / "data/eval/trap-main-v1.jsonl"),
            "--eval-trap-manifest", str(self.root / "manifests/trap-main-v1.manifest.json"),
        ])

    def test_prepare_uses_gate_and_upload_detects_post_prepare_mutation(self):
        target = self.base / "prepared"
        with mock.patch.object(publish, "build_readme", return_value="Synthetic card\n"), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(publish.cmd_prepare(self.prepare_args(target)), 0)
        publish.validate_release(target)
        self.inject(target, "data/eval/trap-main-v1.jsonl", "fixture@example.test")
        with self.sdk(), self.assertRaises(publish.ReleaseValidationError):
            publish.cmd_upload(self.args(target))
        self.assertEqual(self.remote_events, [])

    def test_prepare_cannot_sanitize_away_credentials_in_metadata(self):
        manifest = self.root / "manifests/cot-sft-manifest.json"
        obj = json.loads(manifest.read_text(encoding="utf-8"))
        obj["source"] = "/home/fixture/sk-" + "s" * 32
        self.write_json(manifest, obj)
        with self.assertRaises(publish.ReleaseValidationError), contextlib.redirect_stdout(io.StringIO()):
            publish.cmd_prepare(self.prepare_args(self.base / "prepared"))

    def test_json_keys_nested_credentials_and_parse_errors_do_not_echo_values(self):
        secret = "sk-" + "k" * 32
        for obj in ({secret: "value"}, {"metadata": {"api_key": "unprefixed-synthetic-credential"}}):
            root = self.package()
            path = root / "manifests/adv-main-v1.manifest.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value.update(obj)
            self.write_json(path, value)
            with self.assertRaises(publish.ReleaseValidationError) as caught:
                publish.validate_release(root)
            self.assertNotIn(secret, str(caught.exception))
            self.assertNotIn("unprefixed-synthetic-credential", str(caught.exception))
        (self.root / "data/cot_sft/train.jsonl").write_text('{"' + secret, encoding="utf-8")
        with self.assertRaises(publish.ReleaseValidationError) as caught:
            publish.validate_release(self.root)
        self.assertNotIn(secret, str(caught.exception))

    def test_duplicate_json_keys_cannot_hide_an_overwritten_secret(self):
        secret = "sk-" + "d" * 32
        for rel in ("data/cot_sft/train.jsonl", "manifests/adv-main-v1.manifest.json"):
            root = self.package()
            (root / rel).write_text('{"description":"' + secret + '","description":"ordinary"}\n', encoding="utf-8")
            with self.assertRaises(publish.ReleaseValidationError) as caught:
                publish.validate_release(root)
            self.assertIn("duplicate_json_key", str(caught.exception))
            self.assertNotIn(secret, str(caught.exception))

    def test_main_hides_os_and_sdk_exception_details(self):
        args = self.args()
        parser = mock.Mock()
        parser.parse_args.return_value = args
        args.func = mock.Mock(side_effect=OSError("synthetic-private-path-and-key"))
        err = io.StringIO()
        with mock.patch.object(publish, "build_parser", return_value=parser), contextlib.redirect_stderr(err):
            self.assertEqual(publish.main(), 1)
        self.assertEqual(err.getvalue(), "publish: type=operation_failed\n")


if __name__ == "__main__":
    unittest.main()
