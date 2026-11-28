import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const explicit = process.env.PYTHON?.trim();
const candidates = explicit
  ? [{ command: explicit, prefix: [] }]
  : [
      { command: "python", prefix: [] },
      { command: "python3", prefix: [] },
      ...(process.platform === "win32" ? [{ command: "py", prefix: ["-3"] }] : []),
    ];

let interpreter;
for (const candidate of candidates) {
  const result = spawnSync(candidate.command, [...candidate.prefix, "--version"], { cwd: root, stdio: "inherit" });
  if (!result.error && result.status === 0) {
    interpreter = candidate;
    break;
  }
  if (explicit) {
    console.error(`PYTHON 指定的解释器启动失败：${explicit}`);
    process.exit(1);
  }
}
if (!interpreter) {
  console.error("未找到 Python 3，请安装解释器或用 PYTHON 指定可执行文件路径。");
  process.exit(1);
}

const suites = [
  ["scripts/weimingzi", "test_export_weimingzi.py"],
  ["scripts", "test_publish_modelscope.py"],
];
for (const [directory, pattern] of suites) {
  const result = spawnSync(interpreter.command, [
    ...interpreter.prefix, "-m", "unittest", "discover", "-s", directory, "-p", pattern, "-v",
  ], { cwd: root, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
