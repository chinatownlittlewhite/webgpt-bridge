#!/usr/bin/env python3
from pathlib import Path

p = Path('agent-runtime/test/sandbox.test.js')
s = p.read_text(encoding='utf-8')

def once(old: str, new: str) -> None:
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:80]!r}')
    s = s.replace(old, new, 1)

once('import assert from "node:assert/strict";\n', 'import assert from "node:assert/strict";\nimport path from "node:path";\n')
once('  assert.ok(wrapped.includes("/trusted/runtime"));\n  assert.ok(wrapped.includes("/trusted/git-meta"));\n', '  assert.ok(wrapped.includes(path.resolve("/trusted/runtime")));\n  assert.ok(wrapped.includes(path.resolve("/trusted/git-meta")));\n')
once('  assert.deepEqual(wrapped.slice(bindIndex, bindIndex + 3), ["--bind", "/workspace", "/workspace"]);\n', '  const resolvedWorkspace = path.resolve("/workspace");\n  assert.deepEqual(wrapped.slice(bindIndex, bindIndex + 3), ["--bind", resolvedWorkspace, resolvedWorkspace]);\n')
once('  assert.match(wrapped[2], /\\/tmp\\/project/);\n  assert.match(wrapped[2], /\\/tmp\\/trusted-runtime/);\n  assert.match(wrapped[2], /\\/tmp\\/git-meta/);\n', '  const profilePath = (value) => path.resolve(value).replaceAll("\\\\", "\\\\\\\\");\n  assert.ok(wrapped[2].includes(profilePath("/tmp/project")));\n  assert.ok(wrapped[2].includes(profilePath("/tmp/trusted-runtime")));\n  assert.ok(wrapped[2].includes(profilePath("/tmp/git-meta")));\n')
p.write_text(s, encoding='utf-8')
print('[ci] normalized cross-platform sandbox test expectations')
