# Pi 全量工具 Schema 与后训练参考

调研日期：2026-11-28。核验目标：`github.com/earendil-works/pi`（`main` 分支，`@earendil-works/pi-coding-agent` v1.7.0）中提供给模型的全部工具定义，供后续多工具后训练数据合成与 Verifier 设计作为 Schema 基准。

---

> 本文是该次外部版本的研究快照，不是本项目默认挂载工具清单。本项目依赖 Pi SDK 1.6.0，实际内置工具、领域装配、预算与审计边界见[当前架构](../architecture.md)。

## 一、工具分层总览

Pi 的工具体系按“内置层级”分为三类，共 **8 个核心内置工具 + 5 个内置扩展系统工具 + 5 个官方示例扩展工具**：

| 层级 | 源码路径（`packages/coding-agent/`） | 包含工具 | 默认激活与说明 |
| :--- | :--- | :--- | :--- |
| **1. 核心内置工具** | `src/core/tools/` | `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` | 默认激活 `read / bash / edit / write`（Windows 可选 `powershell`）；`grep / find / ls` 为可选只读工具 |
| **2. 内置扩展元工具** | `src/extensions/`（`builtin: true, replaceable: true`） | `codemode`, `tool_search`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | 按配置自动加载；外部 MCP Server 工具动态注册为 `mcp__<server>__<tool>` |
| **3. 官方示例扩展工具** | `examples/extensions/` | `todo`, `question`, `questionnaire`, `subagent`, `structured_output` | **非内核内置**，官方参考扩展实现（Pi 内核本身刻意不包含 `todo` / `subagent`） |

共享截断常量（`src/core/tools/truncate.ts`）：
- `DEFAULT_MAX_LINES = 2000`
- `DEFAULT_MAX_BYTES = 50 * 1024`（50KB）
- `GREP_MAX_LINE_LENGTH = 500`

---

## 二、核心内置工具（8 个）

以下 JSON Schema 由源码中的 TypeBox 定义 1:1 展开。

### 1. `read`
- 源码：`packages/coding-agent/src/core/tools/read.ts`
- `description`：`Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`
- `promptSnippet`：`Read file contents`
- `promptGuidelines`：`Use read to examine files instead of cat or sed.`
- `constrainedSampling`：`{ type: "json_schema", strict: "prefer" }`

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to read (relative or absolute)"
    },
    "offset": {
      "type": "number",
      "description": "Line number to start reading from (1-indexed)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to read"
    }
  },
  "required": ["path"]
}
```

- `outputSchema`（供 `codemode` 等编程式调用方接收结构化结果）：
```json
{
  "anyOf": [
    { "type": "string" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "image" },
        "data": { "type": "string" },
        "mimeType": { "type": "string" },
        "note": { "type": "string" }
      },
      "required": ["type", "data", "mimeType", "note"]
    }
  ]
}
```

---

### 2. `bash` 与 `powershell`
- 源码：`packages/coding-agent/src/core/tools/bash.ts`、`packages/coding-agent/src/core/tools/powershell.ts`
- 说明：两者共用同一份 `bashSchema` 与 `bashOutputSchema`，仅 `name`、shell 名称和 `promptSnippet` 不同。
- `description`：
  - `bash`：`Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`
  - `powershell`：同上，将 `bash` 替换为 `PowerShell`。
- `promptSnippet`：
  - `bash`：`Execute bash commands (ls, grep, find, etc.)`
  - `powershell`：`Execute PowerShell commands`
- `promptGuidelines`：`You can inspect PI_* environment variables for current model and session details.`
- `constrainedSampling`：`{ type: "json_schema", strict: "prefer" }`

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Shell command to execute"
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in seconds (optional, no default timeout)"
    }
  },
  "required": ["command"]
}
```

- `outputSchema`（供 `codemode` 使用）：
```json
{
  "type": "object",
  "properties": {
    "output": { "type": "string", "description": "Combined stdout and stderr, possibly truncated" },
    "truncated": { "type": "boolean" },
    "full_output_path": { "type": "string", "description": "Full output, when truncated" },
    "full_output_error": { "type": "string", "description": "Why the full output could not be saved, when truncated and saving failed" },
    "exit_code": { "type": "number" },
    "wall_time_seconds": { "type": "number" }
  },
  "required": ["output", "truncated", "exit_code", "wall_time_seconds"]
}
```

---

### 3. `edit`
- 源码：`packages/coding-agent/src/core/tools/edit.ts`
- 说明：v1.7 主 Schema 已采用 **`edits[]` 数组批量局部替换**（运行时 `prepareEditArguments` 仍兼容旧版平铺 `{ path, oldText, newText }`）。
- `description`：`Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.`
- `promptSnippet`：`Make precise file edits with exact text replacement, including multiple disjoint edits in one call`
- `promptGuidelines`：
  - `Use edit for targeted changes. Batch changes to one file in a single call.`
  - `Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.`
- `constrainedSampling`：`{ type: "json_schema", strict: "prefer" }`

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to edit (relative or absolute)"
    },
    "edits": {
      "type": "array",
      "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
          },
          "newText": {
            "type": "string",
            "description": "Replacement text for this targeted edit."
          }
        },
        "required": ["oldText", "newText"]
      }
    }
  },
  "required": ["path", "edits"]
}
```

---

### 4. `write`
- 源码：`packages/coding-agent/src/core/tools/write.ts`
- `description`：`Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.`
- `promptSnippet`：`Create or overwrite files`
- `promptGuidelines`：`Use write only for new files or complete rewrites.`
- `constrainedSampling`：`{ type: "json_schema", strict: "prefer" }`

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to write (relative or absolute)"
    },
    "content": {
      "type": "string",
      "description": "Content to write to the file"
    }
  },
  "required": ["path", "content"]
}
```

---

### 5. `grep`
- 源码：`packages/coding-agent/src/core/tools/grep.ts`
- `description`：`Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.`
- `promptSnippet`：`Search file contents for patterns (respects .gitignore)`

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Search pattern (regex or literal string)"
    },
    "path": {
      "type": "string",
      "description": "Directory or file to search (default: current directory)"
    },
    "glob": {
      "type": "string",
      "description": "Filter files by glob pattern relative to path, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth"
    },
    "ignoreCase": {
      "type": "boolean",
      "description": "Case-insensitive search (default: false)"
    },
    "literal": {
      "type": "boolean",
      "description": "Treat pattern as literal string instead of regex (default: false)"
    },
    "context": {
      "type": "number",
      "description": "Number of lines to show before and after each match (default: 0)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of matches to return (default: 100)"
    }
  },
  "required": ["pattern"]
}
```

---

### 6. `find`
- 源码：`packages/coding-agent/src/core/tools/find.ts`
- `description`：`Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).`
- `promptSnippet`：`Find files by glob pattern (respects .gitignore)`

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern relative to the search directory, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth"
    },
    "path": {
      "type": "string",
      "description": "Directory to search in (default: current directory)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of results (default: 1000)"
    }
  },
  "required": ["pattern"]
}
```

---

### 7. `ls`
- 源码：`packages/coding-agent/src/core/tools/ls.ts`
- `description`：`List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).`
- `promptSnippet`：`List directory contents`

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory to list (default: current directory)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of entries to return (default: 500)"
    }
  }
}
```

---

## 三、内置扩展系统元工具（5 个）

注册入口：`packages/coding-agent/src/extensions/index.ts`。

### 8. `codemode`
- 源码：`packages/coding-agent/src/extensions/codemode/tool.ts`
- 说明：在 QuickJS Wasm 沙箱中执行 JavaScript，脚本内可使用 `tools.*`、`ALL_TOOLS`、`searchTools()`、`describeTool()`、`store()/load()`、`text()`、`image()`、`exit()`、`console.*`、`models.*`（分类器/生图模型）。
- 暴露级别：`exposure: "model-only"`（脚本内不能递归调 `codemode`）。
- 采样约束：`constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } }`。

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "Raw JavaScript source."
    }
  },
  "required": ["code"]
}
```

---

### 9. `tool_search`
- 源码：`packages/coding-agent/src/extensions/tool-search/tool.ts`
- 说明：使用 BM25 在未声明的 `deferred` / `codemode` 工具元数据上检索，并将命中的工具激活加入 `activeTools`，从下一轮开始向模型声明其完整 Schema。
- `description`：`# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (tool_search) to search for the required tools. For MCP tool discovery, always use tool_search.`
- `promptSnippet`：`Search for tools that are not loaded yet and load the matches`
- 暴露级别：`exposure: "model-only"`。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query for deferred tools."
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of tools to return. Defaults to 8."
    }
  },
  "required": ["query"]
}
```

---

### 10. `list_mcp_resources` 与 `list_mcp_resource_templates`
- 源码：`packages/coding-agent/src/extensions/mcp/resources.ts`
- 说明：连接提供资源的 MCP Server 时注册；两者共用同一输入 Schema。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "MCP server name. Omit to list every server with resources."
    },
    "cursor": {
      "type": "string",
      "description": "Opaque cursor from a previous call with the same server; omit for the first page."
    }
  },
  "additionalProperties": false
}
```

---

### 11. `read_mcp_resource`
- 源码：`packages/coding-agent/src/extensions/mcp/resources.ts`

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."
    },
    "uri": {
      "type": "string",
      "description": "Resource URI to read. Must be one of the URIs returned by list_mcp_resources."
    }
  },
  "required": ["server", "uri"],
  "additionalProperties": false
}
```

> **MCP 工具暴露模式（`src/core/mcp-servers.ts`）**：外部 MCP Server 工具统一命名为 `mcp__<server>__<tool>`，支持四种 `exposure`：`codemode`（默认，脚本中 `searchTools()` 发现并调用）、`deferred`（经 `tool_search` 加载后直接调用）、`direct`（直接声明给模型）、`hidden`（隐藏不可达）。

---

## 四、官方示例扩展工具（5 个参考 Schema）

以下工具位于 `packages/coding-agent/examples/extensions/`，不在 Pi 内核中默认加载，作为扩展生态的标准参考。

### 12. `todo`
- 源码：`packages/coding-agent/examples/extensions/todo.ts`
- `description`：`Manage a todo list. Actions: list, add (text), toggle (id), clear`

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["list", "add", "toggle", "clear"]
    },
    "text": {
      "type": "string",
      "description": "Todo text (for add)"
    },
    "id": {
      "type": "number",
      "description": "Todo ID (for toggle)"
    }
  },
  "required": ["action"]
}
```

---

### 13. `question`
- 源码：`packages/coding-agent/examples/extensions/question.ts`
- `description`：`Ask the user a question and let them pick from options. Use when you need user input to proceed.`（`executionMode: "sequential"`）

```json
{
  "type": "object",
  "properties": {
    "question": {
      "type": "string",
      "description": "The question to ask the user"
    },
    "options": {
      "type": "array",
      "description": "Options for the user to choose from",
      "items": {
        "type": "object",
        "properties": {
          "label": { "type": "string", "description": "Display label for the option" },
          "description": { "type": "string", "description": "Optional description shown below label" }
        },
        "required": ["label"]
      }
    }
  },
  "required": ["question", "options"]
}
```

---

### 14. `questionnaire`
- 源码：`packages/coding-agent/examples/extensions/questionnaire.ts`
- `description`：`Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.`

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "Unique identifier for this question" },
          "label": { "type": "string", "description": "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)" },
          "prompt": { "type": "string", "description": "The full question text to display" },
          "options": {
            "type": "array",
            "description": "Available options to choose from",
            "items": {
              "type": "object",
              "properties": {
                "value": { "type": "string", "description": "The value returned when selected" },
                "label": { "type": "string", "description": "Display label for the option" },
                "description": { "type": "string", "description": "Optional description shown below label" }
              },
              "required": ["value", "label"]
            }
          },
          "allowOther": { "type": "boolean", "description": "Allow 'Type something' option (default: true)" }
        },
        "required": ["id", "prompt", "options"]
      }
    }
  },
  "required": ["questions"]
}
```

---

### 15. `subagent`
- 源码：`packages/coding-agent/examples/extensions/subagent/index.ts`
- `description`：`Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).`

```json
{
  "type": "object",
  "properties": {
    "agent": { "type": "string", "description": "Name of the agent to invoke (for single mode)" },
    "task": { "type": "string", "description": "Task to delegate (for single mode)" },
    "tasks": {
      "type": "array",
      "description": "Array of {agent, task} for parallel execution",
      "items": {
        "type": "object",
        "properties": {
          "agent": { "type": "string", "description": "Name of the agent to invoke" },
          "task": { "type": "string", "description": "Task to delegate to the agent" },
          "cwd": { "type": "string", "description": "Working directory for the agent process" }
        },
        "required": ["agent", "task"]
      }
    },
    "chain": {
      "type": "array",
      "description": "Array of {agent, task} for sequential execution",
      "items": {
        "type": "object",
        "properties": {
          "agent": { "type": "string", "description": "Name of the agent to invoke" },
          "task": { "type": "string", "description": "Task with optional {previous} placeholder for prior output" },
          "cwd": { "type": "string", "description": "Working directory for the agent process" }
        },
        "required": ["agent", "task"]
      }
    },
    "agentScope": {
      "type": "string",
      "enum": ["user", "project", "both"],
      "default": "user",
      "description": "Which agent directories to use. Default: \"user\". Use \"both\" to include project-local agents."
    },
    "confirmProjectAgents": {
      "type": "boolean",
      "default": true,
      "description": "Prompt before running project-local agents. Default: true."
    },
    "cwd": { "type": "string", "description": "Working directory for the agent process (single mode)" }
  }
}
```

---

### 16. `structured_output`
- 源码：`packages/coding-agent/examples/extensions/structured-output.ts`
- 说明：展示 `terminate: true` 终结型工具调用规范（调用后直接结束当前回合，不再生成多余文本），示例字段为 `{ headline: string, summary: string, actionItems: string[] }`。

---

## 五、基于 Pi Schema 做后训练的关键注意点

1. **`edit` 以新版 `edits[]` 数组契约为准**：训练轨迹需覆盖单处修改、同文件多处离散非重叠批量修改、相邻行合并，以及匹配失败后先 `read` 再重试的错误恢复。
2. **双 Loadout 覆盖（默认 4 工具 vs 完整 7 文件工具）**：
   - 默认仅提供 `read / bash / edit / write`（或 Windows 下 `powershell`），此时搜索靠 `bash` 执行 `rg`/`fd`；
   - 开启 `grep / find / ls` 时应优先使用专用只读工具；
   - 无论哪种 Loadout，查看文件内容都应优先用 `read`（带 `offset`/`limit` 分页），避免用 `cat`/`sed`。
3. **MCP 懒加载与脚本编排联动**：
   - `tool_search` 轨迹需训练“按语义检索 → 下一轮拿到新暴露的 `mcp__*` Schema → 精确调用”的两阶段模式；
   - `codemode` 轨迹需训练“批量读取/过滤/多工具编排合并进单段 JS 脚本，仅返回精简结果，跨轮小状态存 `store()/load()`”，并遵守不递归调用 `codemode` 的约束。
4. **`todo` Schema 选型取舍**：官方 `examples/extensions/todo.ts` 仅含 `list / add / toggle / clear`（无 `in_progress` 状态，且单次 `add` 仅能加一条）。若面向复杂长任务后训练，需明确是严格对齐官方示例 `action` Schema，还是采用支持全量状态机（`pending / in_progress / completed`）的自定义 Todo MCP/Extension Schema，并在数据中保留少量 Schema 变体以增强泛化。

---

## 一手来源

- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/mcp-servers.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/index.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/codemode/tool.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/tool-search/tool.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/mcp/resources.ts
- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions
