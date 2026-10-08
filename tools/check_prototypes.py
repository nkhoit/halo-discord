#!/usr/bin/env python3
"""Compile the browser build's C sources natively, syntax only, with the diagnostics the web build silences (-w)
that become wrong code or a wasm-ld signature trap: a function called without a prototype (implicit declaration),
an integer used as a pointer or the other way round (int conversion), and a pointer of another type (incompatible
pointer types). The browser build's compile commands come from build.ninja (configure.py), with emcc's own options
left out, compiled 32-bit as the browser's wasm32 is (-m32: the decompiled structures' size checks hold, and no
error limit hides what follows), a stub emscripten.h (tools/prototype_check_stubs) and the directories in
PROTOTYPE_CHECK_INCLUDES (the SDL3 and GLES headers: .github/workflows/ci.yml); a source that needs a header this
machine lacks is skipped and listed.

Every occurrence must be in tools/prototype_baseline.txt, the decompiled code's known ones: an implicit
declaration by source and function, the others counted by source (a header's are its includer's). Anything new
fails.

    python3 tools/check_prototypes.py [--update-baseline]

CC defaults to clang (gcc also works, with its own messages)."""

import argparse
import collections
import concurrent.futures
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tools" / "prototype_baseline.txt"
STUBS = ROOT / "tools" / "prototype_check_stubs"
CHECKED = ("implicit-function-declaration", "int-conversion", "incompatible-pointer-types",
           "incompatible-function-pointer-types")
DIAGNOSTIC = re.compile(r"^(?P<file>.+?):\d+:\d+: (?:warning|error): (?P<message>.*?)\s*\[-W(?:error=)?(?P<flag>[\w-]+)\]$")
IMPLICIT = re.compile(r"(?:implicit declaration of function|call to undeclared (?:library )?function|"
                      r"implicitly declaring library function) ['\u2018](?P<name>\w+)['\u2019]")
MISSING = re.compile(r"fatal error: '?(?P<header>[^':]+)'?(?::)? (?:file not found|No such file or directory)")


def read_ninja(path):
    """build statements (outputs, rule, inputs, variables) and the file's own variables"""
    lines, joined = path.read_text().split("\n"), []
    for line in lines:
        if joined and joined[-1].endswith("$") and not joined[-1].endswith("$$"):
            joined[-1] = joined[-1][:-1] + line.lstrip()
        else:
            joined.append(line)
    builds, variables, current = [], {}, None
    for line in joined:
        if line.startswith("build "):
            head, _, rest = line[len("build "):].partition(": ")
            parts = rest.split(" | ")[0].split(" || ")[0].split()
            current = {"outputs": head.split(), "rule": parts[0], "inputs": parts[1:], "variables": {}}
            builds.append(current)
        elif line.startswith("  ") and current is not None and " = " in line:
            name, _, value = line.strip().partition(" = ")
            current["variables"][name] = value
        else:
            current = None
            if " = " in line and not line.startswith(("rule ", " ", "#")):
                name, _, value = line.partition(" = ")
                variables[name.strip()] = value
    return builds, variables


def unescape(value):
    return re.sub(r"\$(.)", lambda match: match.group(1), value)


def compile_arguments(cflags, compiler):
    keep = []
    for argument in shlex.split(unescape(cflags)):
        if argument.startswith("--use-port") or argument in ("-w", "-MMD") or argument.startswith("-Wno-error="):
            continue
        keep.append(argument)
    warnings = ["-W" + flag for flag in CHECKED[:3]]
    if "clang" in Path(compiler).name:
        warnings = ["-Wno-everything"] + warnings + ["-W" + CHECKED[3], "-ferror-limit=0"]
    extra = []
    for directory in os.environ.get("PROTOTYPE_CHECK_INCLUDES", "").split(os.pathsep):
        if directory:
            extra += ["-isystem", directory]
    return keep + ["-m32", "-fsyntax-only", "-Wno-error", "-isystem", str(STUBS)] + extra + warnings


def check(compiler, source, cflags):
    command = [compiler] + compile_arguments(cflags, compiler) + [source]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    found, missing, errors = [], None, 0
    for line in (result.stdout + result.stderr).splitlines():
        match = DIAGNOSTIC.match(line.strip())
        if ": error: " in line and not (match and match.group("flag") in CHECKED):
            errors += 1
        if match and match.group("flag") in CHECKED:
            flag = "incompatible-pointer-types" if match.group("flag") == CHECKED[3] else match.group("flag")
            found.append((source, flag, match.group("message")))
        missing_match = MISSING.search(line)
        if missing_match:
            missing = missing_match.group("header")
    return source, found, missing, errors


def keys(diagnostics):
    """what the baseline holds: an implicit declaration by source and function, the others counted by source"""
    result, counts = set(), collections.Counter()
    for file, flag, message in diagnostics:
        implicit = IMPLICIT.search(message)
        if flag == "implicit-function-declaration" and implicit:
            result.add(f"{file}\timplicit\t{implicit.group('name')}")
        else:
            counts[(file, flag)] += 1
    for (file, flag), count in counts.items():
        result.add(f"{file}\t{flag}\t{count}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--update-baseline", action="store_true", help="write what is found as the baseline")
    arguments = parser.parse_args()
    compiler = os.environ.get("CC", "clang")
    ninja = ROOT / "build.ninja"
    if not ninja.exists():
        subprocess.run([sys.executable, "configure.py"], cwd=ROOT, check=True)
    builds, variables = read_ninja(ninja)
    for build in builds:
        if build["rule"] == "web_msvc_semantics":
            scan = unescape(build["variables"].get("scan", variables.get("scan", "")))
            subprocess.run([sys.executable, "tools/linux_msvc_semantics.py", "--output", build["outputs"][0]]
                           + shlex.split(scan), cwd=ROOT, check=True)
    units = [(unescape(build["inputs"][0]), build["variables"].get("cflags", ""))
             for build in builds if build["rule"] == "web_cc" and build["inputs"][0].endswith(".c")]
    diagnostics, skipped, erring = [], [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for source, found, missing, errors in pool.map(lambda unit: check(compiler, *unit), units):
            diagnostics += found
            if missing:
                skipped.append(f"{source} ({missing})")
            elif errors:
                erring.append(f"{source} ({errors})")
    found = keys(diagnostics)
    print(f"{len(units)} sources compiled with {compiler}, {len(skipped)} skipped for a header this machine lacks")
    for line in sorted(skipped):
        print(f"  skipped {line}")
    if erring:
        print(f"{len(erring)} sources with other errors natively (still checked: no error limit): "
              + ", ".join(sorted(erring)[:20]) + (" ..." if len(erring) > 20 else ""))
    if arguments.update_baseline:
        BASELINE.write_text("# tools/check_prototypes.py: the known occurrences (file, kind, function or count)\n"
                            + "".join(line + "\n" for line in sorted(found)))
        print(f"baseline written: {len(found)} entries")
        return 0
    baseline = {line for line in BASELINE.read_text().splitlines() if line and not line.startswith("#")}
    known_counts = {}
    for line in baseline:
        file, kind, what = line.split("\t")
        if kind != "implicit":
            known_counts[(file, kind)] = int(what)
    new = []
    for line in sorted(found):
        file, kind, what = line.split("\t")
        if kind == "implicit" and line not in baseline:
            new.append(line)
        elif kind != "implicit" and int(what) > known_counts.get((file, kind), 0):
            new.append(line)
    for line in new:
        file, kind, what = line.split("\t")
        print(f"NEW {kind}: {file}: {what}" + ("" if kind == "implicit" else
              f" (the baseline has {known_counts.get((file, kind), 0)})"))
        for d_file, d_flag, d_message in diagnostics:
            if d_file == file and (kind == "implicit" and what in d_message or kind == d_flag):
                print(f"    {d_message}")
    if new:
        print(f"{len(new)} new: declare the function (its header, or a prototype) or fix the conversion")
        return 1
    print("no new implicit declarations or pointer conversions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
