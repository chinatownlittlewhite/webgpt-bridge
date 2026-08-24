#!/usr/bin/env python3
from __future__ import annotations
import pathlib
import sys


def clean_path(raw: str) -> str | None:
    raw = raw.strip()
    if raw == '/dev/null':
        return None
    if raw.startswith('a/') or raw.startswith('b/'):
        raw = raw[2:]
    return raw


def apply_hunk(target: pathlib.Path, old_lines: list[str], new_lines: list[str], label: str) -> None:
    old = ''.join(old_lines)
    new = ''.join(new_lines)
    if target.exists():
        text = target.read_text(encoding='utf-8')
    else:
        text = ''
    if old == '':
        if text != '':
            raise SystemExit(f'{label}: add-only hunk requires empty/new file: {target}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new, encoding='utf-8')
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one old-text match in {target}, found {count}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit('usage: apply-loose-patch.py PATCH')
    patch_path = pathlib.Path(sys.argv[1])
    lines = patch_path.read_text(encoding='utf-8').splitlines(keepends=True)
    i = 0
    file_index = 0
    while i < len(lines):
        if not lines[i].startswith('--- '):
            i += 1
            continue
        if i + 1 >= len(lines) or not lines[i + 1].startswith('+++ '):
            raise SystemExit(f'{patch_path}: malformed file header near line {i+1}')
        old_path = clean_path(lines[i][4:])
        new_path = clean_path(lines[i + 1][4:])
        if old_path is None and new_path is None:
            raise SystemExit(f'{patch_path}: both file paths are /dev/null')
        target = pathlib.Path(new_path or old_path)
        deleting_file = new_path is None
        i += 2
        file_index += 1
        hunk_index = 0
        saw_hunk = False
        while i < len(lines):
            if lines[i].startswith('--- ') and i + 1 < len(lines) and lines[i + 1].startswith('+++ '):
                break
            if not lines[i].startswith('@@'):
                i += 1
                continue
            saw_hunk = True
            hunk_index += 1
            i += 1
            old_lines: list[str] = []
            new_lines: list[str] = []
            while i < len(lines):
                line = lines[i]
                if line.startswith('@@'):
                    break
                if line.startswith('--- ') and i + 1 < len(lines) and lines[i + 1].startswith('+++ '):
                    break
                if line.startswith('\\ No newline at end of file'):
                    i += 1
                    continue
                if line.startswith(' '):
                    old_lines.append(line[1:])
                    new_lines.append(line[1:])
                elif line.startswith('-'):
                    old_lines.append(line[1:])
                elif line.startswith('+'):
                    new_lines.append(line[1:])
                else:
                    raise SystemExit(f'{patch_path}: unexpected hunk line {i+1}: {line!r}')
                i += 1
            apply_hunk(target, old_lines, new_lines, f'{patch_path.name} file#{file_index} hunk#{hunk_index}')
        if not saw_hunk:
            raise SystemExit(f'{patch_path}: no hunks for {target}')
        if deleting_file:
            if not target.exists():
                raise SystemExit(f'{patch_path}: delete target vanished unexpectedly: {target}')
            target.unlink()
    print(f'[loose-patch] applied {patch_path}')


if __name__ == '__main__':
    main()
