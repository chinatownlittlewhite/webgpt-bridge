#!/usr/bin/env python3
from pathlib import Path

p = Path('agent-runtime/src/sandbox-verify.js')
s = p.read_text(encoding='utf-8')
old = '''        ...(process.platform === "win32" ? {\n          SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\\\Windows",\n          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\\\Windows",\n          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",\n        } : {}),\n'''
new = '''        ...(process.platform === "win32" ? (() => {\n          const profile = path.join(workspace, ".webgpt-bridge", "windows-profile");\n          const appData = path.join(profile, "AppData", "Roaming");\n          const localAppData = path.join(profile, "AppData", "Local");\n          fs.mkdirSync(appData, { recursive: true });\n          fs.mkdirSync(localAppData, { recursive: true });\n          return {\n            SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\\\Windows",\n            WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\\\Windows",\n            PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",\n            ComSpec: process.env.ComSpec ?? "C:\\\\Windows\\\\System32\\\\cmd.exe",\n            OS: process.env.OS ?? "Windows_NT",\n            USERPROFILE: profile,\n            APPDATA: appData,\n            LOCALAPPDATA: localAppData,\n          };\n        })() : {}),\n'''
count = s.count(old)
if count != 1:
    raise SystemExit(f'expected one sandbox verification env block, found {count}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('[ci] aligned sandbox verification with trusted Windows process environment')
