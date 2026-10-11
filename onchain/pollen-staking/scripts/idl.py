#!/usr/bin/env python3
"""Assemble the Anchor IDL from `cargo test --features idl-build __anchor_private_print_idl` output.

  python3 scripts/idl.py build <printed.txt>   # rewrite idl/pollen_staking.json
  python3 scripts/idl.py check <printed.txt>   # exit 1 if the committed IDL differs (ABI, layouts, events, errors)

Works without the Anchor CLI. Names are stripped of their Rust module path.
"""
import json, re, sys
from pathlib import Path

IDL = Path(__file__).resolve().parent.parent / "idl" / "pollen_staking.json"
META = {"name": "pollen_staking", "version": "0.1.0", "spec": "0.1.0",
        "description": "Fleuri Pollen Staking: stake a fixed SPL mint, earn Pollen-funded wSOL",
        "note": "Generated with scripts/idl.py from `cargo test --features idl-build __anchor_private_print_idl`."}

def strip(o):
    if isinstance(o, dict): return {k: strip(v) for k, v in o.items()}
    if isinstance(o, list): return [strip(v) for v in o]
    if isinstance(o, str): return re.sub(r"^(pollen_staking::)(math::)?", "", o)
    return o

def assemble(text):
    sections = re.findall(r"--- IDL begin (\w+) ---\n(.*?)\n--- IDL end \1 ---", text, re.S)
    if not sections: sys.exit("no IDL sections found; did the idl-build test run?")
    idl = {"address": None, "metadata": META, "instructions": [], "accounts": [], "events": [], "errors": [], "types": []}
    types = {}
    for kind, body in sections:
        if kind == "address": idl["address"] = json.loads(body); continue
        j = strip(json.loads(body))
        if kind == "errors": idl["errors"] = j
        elif kind == "event":
            idl["events"].append(j["event"])
            for t in j["types"]: types[t["name"]] = t
        elif kind == "program":
            idl["instructions"] = j["instructions"]; idl["accounts"] = j["accounts"]
            for t in j["types"]: types[t["name"]] = t
    idl["events"].sort(key=lambda e: e["name"]); idl["accounts"].sort(key=lambda e: e["name"])
    idl["types"] = [types[k] for k in sorted(types)]
    return idl

def main():
    mode, path = sys.argv[1], sys.argv[2]
    idl = assemble(Path(path).read_text())
    if mode == "build":
        IDL.write_text(json.dumps(idl, indent=2) + "\n"); print(f"wrote {IDL}")
    elif mode == "check":
        cur = json.loads(IDL.read_text())
        bad = [k for k in ("address", "instructions", "accounts", "events", "errors", "types") if cur.get(k) != idl[k]]
        if bad: sys.exit(f"committed IDL is stale in: {', '.join(bad)}. Run scripts/idl.py build.")
        print("IDL is current")
    else: sys.exit(__doc__)

if __name__ == "__main__": main()
