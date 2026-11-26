# Third-party components — the fairlearn engine image (`engines/fairlearn`)

What the image ships besides RegulAIt's own shim (`@regulait/engine-fairlearn`, whose npm components are in
`packages/engine-fairlearn/THIRD_PARTY.md`) and our metric step (`fairlearn_metrics.py`, RegulAIt's own code).
ADR-0176 admission rules: MIT, Apache-2.0, BSD, ISC or a public-domain dedication; maintained; pinned; works
air-gapped. Every Python distribution is pinned by version and sha256 in `requirements.txt` and judged at build time by
`licence-gate.mjs` on the INSTALLED closure (a licence outside the list fails the build unless `licence-allow.json`
admits it).

## The engine

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `fairlearn` (PyPI, github.com/fairlearn/fairlearn, © Fairlearn contributors) | `0.15.0` (sha256 `4f4656c25af384fc3369db719231680c4e83beb2e6e075e5dc3c2b27d06455c9`, no extras) | MIT | Group-fairness metrics (ADR-0346): `fairlearn.metrics`' demographic parity difference and ratio, equal opportunity difference and equalized odds difference, computed on a model's mapped decisions so the gateway can check its own `computeFairness` against an independent, widely used implementation. Only `fairlearn.metrics` is imported; no mitigation, plotting or dashboard code runs. |

## Licences outside the ADR-0176 list (admitted by `licence-allow.json`)

Each is a licence the owner accepted for an earlier engine image (ADR-0187 decisions 106 and 193). The allow file marks
every one "reused from ADR-0187 decision N for fairlearn; owner to confirm (ADR-0346)": admitted for the build, NOT a
recorded owner acceptance for fairlearn.

| Subject | Licence | Decision reused |
|---|---|---|
| `python` (the base image's CPython runtime) | PSF-2.0 | 193 (garak) |
| `numpy` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 (Zlib admitted) | 106 (modelscan, garak, spikee) |
| `scipy.libs/libgfortran` (two builds) | GPL-3.0-or-later WITH GCC-exception-3.1 | 106: the same library, accepted inside numpy's wheel |
| `scipy.libs/libquadmath` (two builds) | LGPL-2.1-or-later | 106: the same library, accepted inside numpy's wheel |
| `scikit_learn.libs/libgomp` | GPL-3.0-or-later WITH GCC-exception-3.1 | **accepted by the owner 2026-11-21 (ADR-0346 decision 13)**: a narrow ADR-0176 exception, pinned to one file (below) |

The gate knows two native libraries only this closure bundles, each as its wheel's licence file names it:
`scipy.libs/libscipy_openblas` (OpenBLAS, BSD-3-Clause, with its bundled LAPACK under BSD-3-Clause-Open-MPI, read as
numpy's `libscipy_openblas64_` is) and `scikit_learn.libs/libgomp` (above). scipy's METADATA carries its licence as full
text, so `licence-readings.json` records it as read from the wheel's `LICENSE.txt` (pinned by sha256): BSD-3-Clause.

## Narrow ADR-0176 exception: libgomp (ADR-0346 decision 13)

| Field | Value |
|---|---|
| Library | GNU OpenMP runtime, `scikit_learn.libs/libgomp-e985bcbb.so.1.0.0` |
| Built by | GCC 8.5.0 (2021-05-14), per the file's annobin notes |
| File sha256 | `a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a` |
| Shipped in | `scikit-learn==1.9.1`, wheel `scikit_learn-1.9.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`, sha256 `e5d7b18a5b9dca241a74695f3275fa4c895a9dadc72b3d8df5fa9d1083c9b83e` (`requirements.txt`) |
| Licence | GPL-3.0-or-later WITH GCC-exception-3.1, as the wheel's `licenses/COPYING` names it. The GCC Runtime Library Exception permits linking and distributing it with code under any licence. |
| Unmet requirement | scikit-learn's published wheels compile OpenMP in and always bundle libgomp. fairlearn requires scikit-learn, and no validated alternative to fairlearn fits (ADR-0346's comparison). |
| How it is pinned | The wheel is hash-pinned (`pip install --require-hashes`), and the licence gate admits only a file with the sha256 above. Any other libgomp is DENIED and the image build fails. |
| Re-check when | scikit-learn's version or wheel hash changes; the bundled libgomp changes (the gate fails the build first); or scikit-learn ships a wheel without libgomp. |

Not scanned by the gate (CI's image scan covers it): the base image's OS layer.

## The Python closure (all 11 distributions, as the gate reads them)

| Distribution | Version | Licence |
|---|---|---|
| `cloudpickle` | `3.1.2` | BSD-3-Clause |
| `fairlearn` | `0.15.0` | MIT |
| `joblib` | `1.6.0` | BSD-3-Clause |
| `narwhals` | `2.28.0` | MIT |
| `numpy` | `2.5.5` | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| `pandas` | `3.1.1` | BSD-3-Clause |
| `python-dateutil` | `4.0.0` | BSD-3-Clause |
| `scikit-learn` | `1.9.1` | BSD-3-Clause |
| `scipy` | `1.18.1` | BSD-3-Clause (read from its LICENSE.txt) |
| `threadpoolctl` | `3.8.0` | BSD-3-Clause |
| `tzdata` | `2026.6` | Apache-2.0 |

## Bundled native libraries (inside the wheels)

| Library | Wheel | Licence |
|---|---|---|
| `libscipy_openblas64_` | numpy | BSD-3-Clause |
| `libscipy_openblas` | scipy | BSD-3-Clause |
| `libgfortran` (two builds) | scipy | GPL-3.0-or-later WITH GCC-exception-3.1 |
| `libquadmath` (two builds) | scipy | LGPL-2.1-or-later |
| `libgomp` | scikit-learn | GPL-3.0-or-later WITH GCC-exception-3.1 |

## Runtime

| Component | Version | Licence | Used for |
|---|---|---|---|
| `python:3.12-slim-trixie` base (pinned by digest, the same as garak's and spikee's) | CPython 3.12 | PSF-2.0 (runtime); Debian packages under their own licences | The venv's interpreter. pip is removed from the runtime image. |
| `node:22-trixie-slim` (the `node` binary only, pinned by digest) | Node.js 22 | MIT | The runner and the task shim. |
