#!/usr/bin/env python3
"""Set the program ID everywhere it is compiled in, without the Anchor CLI.

  python3 scripts/sync-program-id.py <base58 program id>

Updates declare_id! (lib.rs), Anchor.toml and the committed IDL address. The app client never
reads the deployment ID from these files: it uses POLLEN_STAKING_PROGRAM_ID and treats only the
fixed PLACEHOLDER_PROGRAM_ID in src/pq/staking.ts as "not deployed". Rebuild afterwards, then
regenerate the IDL with scripts/idl.py build and rerun all tests.
"""
import json, re, sys
from pathlib import Path

B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2 or not B58.match(sys.argv[1]): sys.exit(__doc__)
pid = sys.argv[1]
lib = root / "programs/pollen-staking/src/lib.rs"
s, n = re.subn(r'declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\)', f'declare_id!("{pid}")', lib.read_text())
assert n == 1, "declare_id! not found exactly once"; lib.write_text(s)
toml = root / "Anchor.toml"
t, n = re.subn(r'(pollen_staking = )"[1-9A-HJ-NP-Za-km-z]+"', rf'\1"{pid}"', toml.read_text())
assert n >= 1; toml.write_text(t)
idl = root / "idl/pollen_staking.json"; j = json.loads(idl.read_text()); j["address"] = pid
idl.write_text(json.dumps(j, indent=2) + "\n")
print(f"program id set to {pid} in lib.rs, Anchor.toml, IDL. Now rebuild and run scripts/idl.py build.")
