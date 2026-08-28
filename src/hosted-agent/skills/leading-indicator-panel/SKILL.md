---
name: leading-indicator-panel
description: Inspect, stage, validate, cutoff-filter, and transform individual series or small subsets of the nowcasting leading-indicator panel in refresh.db:indicator_history. Use for availability, coverage, latest-value, release-admissibility, and common transformation questions such as YoY log growth before using a larger nowcasting skill. Status — Complete.
---

# Leading Indicator Panel

Use this foundational skill for questions about the nowcasting indicator panel
that do **not** yet require fitting a forecasting model. It establishes the data
contract shared by monthly ADL work and future mixed-frequency methods such as
MIDAS.

## 1. Preserve the requested scope

Classify the request before computing:

| Request | Action |
|---|---|
| Is series `X` available? What is its coverage? | Metadata inspection only; report presence, count, range, and panel hash. Do not infer a request for analysis or a chart. |
| Show first/latest values for `X` | Stage only `X`; read values in Python; return only the requested observations. |
| Transform `X` through cutoff `C` | Stage only `X`; filter in Python to `date <= C`; calculate only the named transform. |
| Determine release admissibility | Apply §5 after staging only the requested series. |
| Fit/compare/nowcast/forecast | Read the applicable modeling skill after this one. |
| Visualize | Prepare a compact chart-feed file, then hand it to the coder. |

Do not search the artifact catalog when the user explicitly asks about
`refresh.db:indicator_history`. Do not escalate a metadata or arithmetic
question into trend analysis, model fitting, visualization, or artifact
creation.

## 2. Canonical monthly panel

| series_id | Plain name | Family | Default ADL transform | Release lag |
|---|---|---|---|---:|
| `m3_total_shipments_nsa` | Total manufacturing shipments, NSA | M3 target | YoY log growth | 2 |
| `m3_new_orders` | Manufacturers' new orders | M3 orders | YoY log growth | 2 |
| `m3_unfilled_orders` | Manufacturers' unfilled orders | M3 orders | YoY log growth | 2 |
| `fred_ipman` | Manufacturing industrial production | Activity | YoY log growth | 1 |
| `fred_mcumfn` | Manufacturing capacity utilization | Activity | Level | 1 |
| `fred_tcu` | Total industry capacity utilization | Activity | Level | 1 |
| `bls_ces_mfg_employment` | Manufacturing employment | Labor | YoY log growth | 1 |
| `bls_ces_mfg_hours` | Manufacturing average weekly hours | Labor | Level | 1 |
| `bls_ppi_mfg` | Manufacturing producer price index | Prices | YoY log growth | 1 |
| `fred_cfnai` | Chicago Fed National Activity Index | Activity index | Level | 1 |
| `fred_empire_state_mfg` | Empire State manufacturing survey | Survey | Level | 0 |
| `fred_philly_fed_mfg` | Philadelphia Fed manufacturing survey | Survey | Level | 0 |
| `fred_dallas_fed_mfg` | Dallas Fed manufacturing survey | Survey | Level | 0 |

The current panel is monthly. Preserve separate `date` and availability/vintage
concepts in any derived output so a future MIDAS skill can add weekly or daily
observations without redefining the cutoff contract.

## 3. Stage data through `execute_python`

For any value-level operation, call `execute_python` with
`stage_indicator_panel`. Name only the series required by the question.

```json
{
  "stage_indicator_panel": {
    "subject": "M3 Manufacturing Shipments",
    "series": ["bls_ppi_mfg"],
    "path": "inputs/indicator-panel.json"
  },
  "code": "<agent-authored Python>"
}
```

The runtime writes raw observations to the workspace before Python starts. Raw
rows are not returned to the LLM. The runtime performs no transformation or
statistical method; Python must open and process the staged file.

## 4. Exact staged JSON schema

Do not guess the shape. `series` is a list of IDs; observations are nested
under `rows`.

```json
{
  "subjectId": "M3 Manufacturing Shipments",
  "series": ["bls_ppi_mfg"],
  "rows": [
    {
      "seriesId": "bls_ppi_mfg",
      "observations": [
        {"date": "2003-01", "value": 135.7, "is_preliminary": 0}
      ]
    }
  ],
  "panelHash": "<sha256>"
}
```

Canonical conversion to a long DataFrame:

```python
import json
import pandas as pd

with open("inputs/indicator-panel.json", encoding="utf-8") as f:
    payload = json.load(f)

records = [
    {
        "series_id": row["seriesId"],
        "date": obs["date"],
        "value": float(obs["value"]),
        "is_preliminary": int(obs.get("is_preliminary", 0)),
    }
    for row in payload["rows"]
    for obs in row["observations"]
]
panel = pd.DataFrame.from_records(records)
panel["date"] = pd.PeriodIndex(panel["date"], freq="M")
panel = panel.sort_values(["series_id", "date"]).reset_index(drop=True)
```

Fail honestly if:

- The requested `seriesId` is absent.
- Its `observations` array is empty.
- Dates are duplicated or not monthly where monthly cadence is required.
- Values needed for a transformation are missing or non-positive.
- The cutoff leaves insufficient history.

## 5. Cutoffs and release admissibility

Distinguish two questions:

1. **Explicit observation cutoff:** “through end-May 2026” means first filter
   every staged series to `date <= 2026-05`.
2. **Nowcast information set:** for target month `t`, use the release rule in
   the modeling skill. In the canonical early-month ADL decision:
   - lag 0 surveys: through `t-1`;
   - lag 1 indicators: through `t-1` when that print is explicitly treated as
     available early in `t`;
   - lag 2 M3 series: through `t-2`.

Never use a post-cutoff value in a transformation, feature, fit, or prediction.
A realized target may appear after the cutoff only when a modeling skill
explicitly permits it for retrospective scoring.

Python cutoff pattern:

```python
cutoff = pd.Period("2026-05", freq="M")
series = panel.loc[
    (panel["series_id"] == "bls_ppi_mfg") & (panel["date"] <= cutoff)
].copy()
```

## 6. Common transformations

### Level

Use the filtered observed value directly. Appropriate for utilization, hours,
CFNAI, and survey diffusion indexes in the canonical ADL.

### YoY log growth

For a positive monthly level `X`:

```text
g_t = log(X_t) - log(X_{t-12})
```

Compute after sorting and cutoff filtering:

```python
import numpy as np

if (series["value"] <= 0).any():
    raise ValueError("YoY log growth requires positive levels")
series["yoy_log_growth"] = np.log(series["value"]) - np.log(series["value"].shift(12))
latest = series.dropna(subset=["yoy_log_growth"]).iloc[-1]
```

Report both:

- log change: `g_t`;
- percent-equivalent change: `100 * (exp(g_t) - 1)`.

Do not label `100*g_t` as the exact percentage change; it is only the
log-point approximation.

## 7. Minimal output contract

For a simple access, value, or transformation test, print one compact JSON
object to stdout and do not create files unless the user asks for them or a
downstream step needs them.

```json
{
  "skill": "leading-indicator-panel",
  "seriesId": "bls_ppi_mfg",
  "cutoff": "2026-05",
  "latestDate": "2026-05",
  "level": 0.0,
  "comparisonDate": "2025-05",
  "comparisonLevel": 0.0,
  "yoyLogGrowth": 0.0,
  "yoyPercent": 0.0,
  "isPreliminary": 0,
  "panelHash": "..."
}
```

For deterministic arithmetic such as a log difference, do not invent a
sampling confidence interval. State that no sampling uncertainty is attached
to the arithmetic transformation; relevant uncertainty comes from preliminary
status, revisions, measurement, cutoff assumptions, and—in a later modeling
skill—forecast error.

## 8. Handoff to modeling skills

After panel access and transformations pass, read the applicable modeling
skill:

- Monthly M3 ADL: `adl-monthly-nowcast`
- Future mixed-frequency work: a dedicated MIDAS skill

A modeling skill owns feature design, estimator selection, validation,
prediction intervals, and model artifacts. This foundational skill owns only
panel identity, staging, schema parsing, cutoff discipline, common transforms,
and compact inspection outputs.
