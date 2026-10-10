"""ADR-0187 B5-G (decisions 198-200) — pre-seed the licence-clear Hugging Face assets into the image, and
prove they load offline.

    python -I preseed-hf.py fetch       hf-preseed.json <HF_HOME>   # build time, the ONE step with network
    python -I preseed-hf.py materialise hf-preseed.json <HF_HOME>   # build time, after fetch
    python -I preseed-hf.py verify      hf-preseed.json <HF_HOME>   # offline: no network, switches set

FETCH, for each asset in hf-preseed.json (owner decision 2026-10-10, open question 22; the R10 list):
  - the licence is read AT THE PINNED REVISION: the repository card (README.md) at that commit must name
    exactly the licence the manifest records, and that licence must be MIT or Apache-2.0 (ADR-0176);
  - every listed file is downloaded at that commit (never a branch) and its sha256 and size must be the
    manifest's; a file the manifest does not list is never fetched;
  - `refs/main` is written with the pinned commit, so an offline load that names no revision (as garak's
    detectors and probes do) resolves to it (R10: without it the offline load fails);
MATERIALISE: each dataset is built with `datasets.load_dataset(id, split="train", revision=<commit>)`,
    which is what an offline `load_dataset` reads (a raw snapshot alone is not enough for datasets 3.6:
    measured, an offline build from the snapshot is refused). It runs right after fetch, so the data files
    it reads are the ones fetch verified (the Hub cache is content-addressed); afterwards every cached
    snapshot file must be listed in the manifest and still match, and no other commit may be cached.
VERIFY (run with no network at all, HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / HF_DATASETS_OFFLINE set),
in the worker's per-probe layout (`worker_layout`), so the pre-seeded tree itself is only read:
  - every listed file is present in the snapshot of its pinned commit with the manifest's sha256;
    `refs/main` names that commit;
  - each model loads the way garak's HFDetector loads it (AutoConfig, AutoModelForSequenceClassification,
    AutoTokenizer, by repository id with no revision) and classifies one input;
  - each dataset loads the way garak loads it (`load_dataset(id, split="train")`, no revision) and has at
    least `minRows` rows with the column garak reads.
Exit 1 on any difference. Nothing here is executed from a downloaded repository (no remote code).
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile

LICENCES = {"apache-2.0", "mit"}
SWITCHES = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}


def fail(msg: str) -> None:
    print(f"preseed-hf: {msg}")
    sys.exit(1)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(path: str) -> list:
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    assets = m.get("assets")
    if not isinstance(assets, list) or not assets:
        fail("the manifest lists no assets")
    for a in assets:
        if a.get("kind") not in ("model", "dataset"):
            fail(f"{a.get('id')}: kind must be model or dataset")
        if not re.fullmatch(r"[0-9a-f]{40}", a.get("revision", "")):
            fail(f"{a.get('id')}: the revision must be a full commit sha")
        if a.get("licence") not in LICENCES:
            fail(f"{a.get('id')}: licence {a.get('licence')!r} is not MIT or Apache-2.0")
        names = [f["path"] for f in a.get("files", [])]
        if "README.md" not in names:
            fail(f"{a['id']}: the card (README.md) must be listed: the licence is read from it")
        for f in a["files"]:
            if not re.fullmatch(r"[0-9a-f]{64}", f.get("sha256", "")) or not isinstance(f.get("size"), int):
                fail(f"{a['id']}/{f.get('path')}: needs a sha256 and a size")
            if f["path"].startswith("/") or ".." in f["path"].split("/"):
                fail(f"{a['id']}/{f['path']}: not a relative repository path")
    return assets


def repo_dir(hf_home: str, a: dict) -> str:
    prefix = "models" if a["kind"] == "model" else "datasets"
    return os.path.join(hf_home, "hub", f"{prefix}--{a['id'].replace('/', '--')}")


def card_licence(text: str) -> str | None:
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return None
    lic = re.search(r"^license:\s*(\S+)\s*$", m.group(1), re.M)
    return lic.group(1).strip("'\"").lower() if lic else None


def check_files(hf_home: str, a: dict) -> None:
    snap = os.path.join(repo_dir(hf_home, a), "snapshots", a["revision"])
    for f in a["files"]:
        p = os.path.join(snap, f["path"])
        if not os.path.isfile(p):
            fail(f"{a['id']}@{a['revision'][:8]}: {f['path']} is missing")
        got = sha256(p)
        if got != f["sha256"] or os.path.getsize(p) != f["size"]:
            fail(f"{a['id']}@{a['revision'][:8]}: {f['path']} is {got}, the manifest pins {f['sha256']}")
    with open(os.path.join(repo_dir(hf_home, a), "refs", "main"), encoding="utf-8") as r:
        if r.read().strip() != a["revision"]:
            fail(f"{a['id']}: refs/main is not the pinned revision")
    with open(os.path.join(snap, "README.md"), encoding="utf-8") as r:
        lic = card_licence(r.read())
    if lic != a["licence"]:
        fail(f"{a['id']}@{a['revision'][:8]}: the card's licence is {lic!r}, the manifest records {a['licence']!r}")


def fetch(assets: list, hf_home: str) -> None:
    os.environ["HF_HOME"] = hf_home
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from huggingface_hub import hf_hub_download

    for a in assets:
        for f in a["files"]:
            hf_hub_download(a["id"], f["path"], revision=a["revision"], repo_type=a["kind"])
        refs = os.path.join(repo_dir(hf_home, a), "refs")
        os.makedirs(refs, exist_ok=True)
        with open(os.path.join(refs, "main"), "w", encoding="utf-8") as r:
            r.write(a["revision"])
        check_files(hf_home, a)
        print(f"preseed-hf: fetched {a['kind']} {a['id']}@{a['revision'][:8]} ({a['licence']}, {len(a['files'])} files, hashes match)")


def offline_only() -> None:
    for k, v in SWITCHES.items():
        if os.environ.get(k) != v:
            fail(f"this step runs offline only: {k} must be {v}")


def worker_layout(hf_home: str, root: str) -> dict:
    """the worker's per-probe layout (packages/engine-garak config.ts, garak-run.ts): a fresh writable
    HF_HOME, HF_HUB_CACHE = the read-only pre-seeded hub cache, and a fresh writable HF_DATASETS_CACHE whose
    entries are symlinks to the read-only materialised datasets (datasets takes a lock file in its cache
    root, so that root cannot be the read-only tree; the data itself stays read-only)"""
    home = os.path.join(root, "hf-home")
    dcache = os.path.join(root, "hf-datasets")
    os.makedirs(home)
    os.makedirs(dcache)
    src = os.path.join(hf_home, "datasets")
    for n in sorted(os.listdir(src)):
        if os.path.isdir(os.path.join(src, n)):
            os.symlink(os.path.join(src, n), os.path.join(dcache, n))
    return {"HF_HOME": home, "HF_HUB_CACHE": os.path.join(hf_home, "hub"), "HF_DATASETS_CACHE": dcache}


def materialise(assets: list, hf_home: str) -> None:
    """build each dataset's cache at its pinned commit, then prove the Hub cache holds only verified files"""
    os.environ["HF_HOME"] = hf_home
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import datasets

    for a in assets:
        if a["kind"] == "dataset":
            check_files(hf_home, a)
            ds = datasets.load_dataset(a["id"], split="train", revision=a["revision"])
            print(f"preseed-hf: materialised {a['id']}@{a['revision'][:8]} ({ds.num_rows} rows)")
    # the build read only what fetch verified: every file in every snapshot is listed and still matches
    for a in assets:
        check_files(hf_home, a)
        snaps = os.path.join(repo_dir(hf_home, a), "snapshots")
        if sorted(os.listdir(snaps)) != [a["revision"]]:
            fail(f"{a['id']}: a snapshot other than the pinned commit is cached")
    for a in assets:
        snap = os.path.join(repo_dir(hf_home, a), "snapshots", a["revision"])
        listed = {f["path"] for f in a["files"]}
        for dirpath, _, names in os.walk(snap):
            for n in names:
                rel = os.path.relpath(os.path.join(dirpath, n), snap)
                if rel not in listed:
                    fail(f"{a['id']}: {rel} is in the snapshot but not in the manifest")
    # what the downloads and the build left behind that nothing reads offline: download locks, the
    # transfer client's cache and logs, the dataset-script module cache, the cache-root build locks
    for d in ("xet", "modules", os.path.join("hub", ".locks")):
        shutil.rmtree(os.path.join(hf_home, d), ignore_errors=True)
    for n in os.listdir(os.path.join(hf_home, "datasets")):
        if n.endswith(".lock"):
            os.remove(os.path.join(hf_home, "datasets", n))


def verify(assets: list, hf_home: str) -> None:
    offline_only()
    for a in assets:
        check_files(hf_home, a)
    os.environ.update(worker_layout(hf_home, tempfile.mkdtemp(prefix="preseed-verify-")))
    import datasets
    import torch
    from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

    for a in assets:
        if a["kind"] == "model":
            config = AutoConfig.from_pretrained(a["id"])
            model = AutoModelForSequenceClassification.from_pretrained(a["id"], config=config)
            tok = AutoTokenizer.from_pretrained(a["id"])
            with torch.no_grad():
                out = model(**tok(["The sky is green."], return_tensors="pt", truncation=True))
            if out.logits.shape[-1] < 2:
                fail(f"{a['id']}: the classifier returned no classes")
            print(f"preseed-hf: loaded model {a['id']} offline ({out.logits.shape[-1]} classes)")
        else:
            ds = datasets.load_dataset(a["id"], split="train")
            col = a.get("column")
            if ds.num_rows < a.get("minRows", 1) or (col and col not in ds.column_names):
                fail(f"{a['id']}: {ds.num_rows} rows, columns {ds.column_names}")
            print(f"preseed-hf: loaded dataset {a['id']} offline ({ds.num_rows} rows)")
    print(f"preseed-hf: {len(assets)} pre-seeded assets verified offline")


def main() -> None:
    steps = {"fetch": fetch, "materialise": materialise, "verify": verify}
    if len(sys.argv) != 4 or sys.argv[1] not in steps:
        fail("usage: preseed-hf.py fetch|materialise|verify <hf-preseed.json> <HF_HOME>")
    assets = load_manifest(sys.argv[2])
    hf_home = os.path.abspath(sys.argv[3])
    steps[sys.argv[1]](assets, hf_home)


if __name__ == "__main__":
    main()
