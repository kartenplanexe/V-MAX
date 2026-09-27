"""Read installed wheel metadata and license hashes against a supplied uv.lock.

Run inside the exact runtime image for Linux evidence. Prints only package data;
does not inspect application environment or contact package repositories.
"""
import hashlib
import importlib.metadata
import json
import pathlib
import platform
import re
import sys
import tomllib

lock_bytes = pathlib.Path(sys.argv[1]).read_bytes().replace(b"\r\n", b"\n")
lock = tomllib.loads(lock_bytes.decode("utf-8"))
locked = {item["name"]: item for item in lock["package"] if "virtual" not in item["source"]}
packages = []
for dist in importlib.metadata.distributions():
    name = re.sub(r"[-_.]+", "-", dist.metadata["Name"]).lower()
    if name not in locked or dist.version != locked[name]["version"]:
        raise RuntimeError(f"Installed package is not pinned by this lockfile: {name}")
    licenses = []
    for file in dist.files or []:
        if re.match(r"^(LICENSE|LICENCE|COPYING|NOTICE)([.\-]|$)", file.name, re.I):
            path = dist.locate_file(file)
            if path.is_file():
                licenses.append({"path": str(file), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    declared = dist.metadata.get("License-Expression") or dist.metadata.get("License")
    if not declared or declared.upper() == "UNKNOWN" or len(declared) > 200:
        declared = None
    packages.append({
        "name": name, "version": dist.version,
        "license_metadata": declared,
        "license_classifiers": [item for item in dist.metadata.get_all("Classifier", []) if item.startswith("License ::")],
        "license_files": sorted(licenses, key=lambda item: item["path"]),
        "source_sdist": locked[name].get("sdist", {}),
    })
print(json.dumps({
    "schema_version": 1,
    "scope": "Installed Python distributions only; license metadata and retained license-file hashes, not OS packages or a legal clearance.",
    "platform": platform.system(), "python": platform.python_version(),
    "lockfile_hash_encoding": "UTF-8 with LF line endings",
    "lockfile_sha256": hashlib.sha256(lock_bytes).hexdigest(),
    "packages": sorted(packages, key=lambda item: item["name"]),
}, ensure_ascii=False, indent=2))
