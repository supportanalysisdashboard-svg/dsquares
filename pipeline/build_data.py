#!/usr/bin/env python3
"""Build the static-site data files for the Support Analysis Dashboard.

Downloads the six Google Sheets via the public CSV export, processes them with
exactly the same logic as the old Streamlit app (short-name renames, project
renames, date derivation, ticket status), and writes ready-to-serve JSON files
under web/data/. Runs hourly via GitHub Actions; the website never touches
Google Sheets directly.

Outputs:
  web/data/meta.json      build metadata, filter option lists, quality board parse
  web/data/tickets.json   processed merchant+client ticket rows (columnar)
  web/data/agent.json     agent_perf sheet (cols + rows)
  web/data/sla.json       inbound_sla sheet (cols + rows)
  web/data/redemption.json redemption sheet (cols + rows)
"""

import concurrent.futures
import gzip
import json
import math
import os
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

S_ID = "1f3L3zsB9u_kje2QezsL5qWKeg0vfbVDK8u42Q_gaio8"

SHEET_GIDS = {
    "merchant_support": 471895160,
    "client_support": 1950888044,
    "quality_board": 10002,
    "agent_perf": 1306770575,
    "inbound_sla": 1713632809,
    "redemption": 17439532,
}

BLACK_LIST = ['', 'n/a', 'n.a', 'n', 'dropped call', 'call dropped', 'out of our scope', 'other', '0', 'na', ' ', 'N', 'none', 'nan', 'N/A', '0.0', 'NaN', 'None', 'n/m', 'N/M', "what's app"]

SHORT_NAMES = {
    "Not Done": "Solved",
    "This Number Belongs To An Inactive Wallet": "Inactive Wallet",
    "Escalated- Tech Support": "Esc-Tech",
    "Escalated- Field Team": "Esc-FO",
    "Escalated- Management Team": "Esc-MGT",
    "Escalated- Sys.Set-Up": "Esc-Sys",
    "Escalated- Monitoring Team": "Esc-M&C",
    "Escalated- Product Team": "Esc-PR",
    "Escalated- CCubed Team": "Esc-CCubed",
    "Escalated- Data Team": "Esc-Data",
    "Escalated- Fraud Team": "Esc-Fraud",
    "Escalated- YGG/Like Card": "Esc-YGG",
    "Escalated- PS Team": "Esc-PS",
    "Escalated- PM Team": "Esc-PM",
    "Escalated- AM Team": "Esc-AM",
    "Escalated- Merchant": "Esc - Merchant",
    "Connection Problem or Invalid MMI Code": "Connection Problem",
    "Mismatch (Coupon Number & CST MSISDN)": "Mismatch",
}

PROJECT_RENAME = {"Red Ramadan": "VF Red Ramadan"}

TZ = ZoneInfo("Africa/Cairo")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data")


def csv_url(gid):
    return f"https://docs.google.com/spreadsheets/d/{S_ID}/export?format=csv&gid={gid}"


def load_csv(gid):
    return pd.read_csv(csv_url(gid), dtype=str).dropna(axis=1, how="all").fillna("")


def process_ticket_df(d):
    """Mirror _process_ticket_df from the Streamlit app."""
    if d.empty:
        return d
    d = d[d.iloc[:, 0].astype(str).str.strip() != ""].copy()
    for old, new in SHORT_NAMES.items():
        d = d.replace(old, new)
    d_col = next((c for c in d.columns if any(k in c.lower() for k in ["created", "date"])), d.columns[0])
    dt = pd.to_datetime(d[d_col], errors="coerce")
    d["D_Obj"] = dt.dt.strftime("%Y-%m-%d").fillna("")
    d = d[d["D_Obj"] != ""]
    return d


def to_numeric(series):
    return pd.to_numeric(series.astype(str).str.replace("%", "").str.replace(",", ""), errors="coerce").fillna(0)


def clean_col(df, col):
    if col not in df.columns:
        return df
    t = df.copy()
    t[col] = t[col].astype(str).str.strip()
    mask = (t[col] != "") & (~t[col].str.lower().isin([x.lower() for x in BLACK_LIST]))
    return t[mask]


def rows_to_columnar(df, drop=()):
    cols = [c for c in df.columns if c not in drop]
    rows = [list(r) for r in df[cols].itertuples(index=False)]
    return {"cols": cols, "rows": rows}


def clean_json(obj):
    """Recursively convert non-finite floats (NaN/Inf) to null so the output is
    always valid JSON (pandas leaves NaN after concat of different-width sheets)."""
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: clean_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_json(v) for v in obj]
    return obj


def _norm_row(r):
    return [('' if x is None else str(x)).strip() for x in r]


def _find_row(rows, labels):
    """Index of the first data row containing ALL given labels (case-insensitive)."""
    for i, r in enumerate(rows):
        cells = [c.lower() for c in r]
        if all(any(lbl in c for c in cells) for lbl in labels):
            return i
    return -1


def _col_idx(row, label):
    for i, c in enumerate(row):
        if label.lower() in c.lower():
            return i
    return -1


def _is_int(s):
    return bool(s) and s.replace(".", "").isdigit()


def parse_quality_board(raw):
    """Mirror the inline parsing from the Streamlit app (agent summary, top errors,
    per-agent errors). The sheet's empty first row becomes the pandas header after
    load_csv, which shifts every column by one, so sections are located by label
    search instead of hard-coded column offsets — this also tolerates layout drift."""
    rows = [_norm_row(r) for r in raw.itertuples(index=False)]
    summary = []
    top_errors = {"EC": [], "BC": [], "NC": []}
    per_agent = []

    # ---- agent summary (Agent Name | Total Volume | Avg EC% | Avg BC% | Overall Avg) ----
    si = _find_row(rows, ["agent name", "total volume"])
    if si >= 0:
        hr = rows[si]
        ci = {
            "Agent": _col_idx(hr, "agent name"),
            "Volume": _col_idx(hr, "total volume"),
            "EC": _col_idx(hr, "avg ec"),
            "BC": _col_idx(hr, "avg bc"),
            "OA": _col_idx(hr, "overall avg"),
        }
        for j in range(si + 1, len(rows)):
            r = rows[j]
            name = r[ci["Agent"]] if ci["Agent"] >= 0 else ""
            vol = r[ci["Volume"]] if ci["Volume"] >= 0 else ""
            if not name or not _is_int(vol):
                break
            summary.append({
                "Agent": name,
                "Volume": vol,
                "Avg EC%": r[ci["EC"]] if ci["EC"] >= 0 else "",
                "Avg BC%": r[ci["BC"]] if ci["BC"] >= 0 else "",
                "Overall Avg": r[ci["OA"]] if ci["OA"] >= 0 else "",
            })

    # ---- top errors (Top EC Errors | Count  Top BC Errors | Count  Top NC Errors | Count) ----
    ti = _find_row(rows, ["top ec errors", "top bc errors"])
    if ti >= 0:
        hr = rows[ti]
        groups = {}
        for et in ("EC", "BC", "NC"):
            head = _col_idx(hr, f"top {et} errors")
            cnt = -1
            if head >= 0:
                for k in range(head + 1, len(hr)):
                    if hr[k].lower() == "count":
                        cnt = k
                        break
            groups[et] = (head, cnt)
        for j in range(ti + 1, len(rows)):
            r = rows[j]
            if not any(r):
                break
            for et, (head, cnt) in groups.items():
                if head >= 0 and cnt >= 0 and r[head] and _is_int(r[cnt]):
                    top_errors[et].append({"Error": r[head], "Count": r[cnt]})

    # ---- per-agent errors (Agent | EC Error | Count | Agent | BC Error | Count | Agent | NC Error | Count) ----
    pi = _find_row(rows, ["ec error", "agent"])
    if pi >= 0:
        hr = rows[pi]
        groups = {}
        for et in ("EC", "BC", "NC"):
            head = _col_idx(hr, f"{et} error")
            ag = cnt = -1
            if head >= 0:
                ag = head - 1 if head - 1 >= 0 else -1
                cnt = head + 1 if head + 1 < len(hr) else -1
            groups[et] = (ag, head, cnt)
        for j in range(pi + 1, len(rows)):
            r = rows[j]
            if not any(r):
                break
            for et, (ag, head, cnt) in groups.items():
                if ag >= 0 and head >= 0 and cnt >= 0 and r[ag] and r[head] and _is_int(r[cnt]):
                    per_agent.append({"Agent": r[ag], "Type": et, "Error": r[head], "Count": r[cnt]})

    return {"agent_summary": summary, "top_errors": top_errors, "per_agent_errors": per_agent}


def build_agent(raw):
    """Pre-aggregate agent_perf the same way the app does (avg EC%/BC% per agent,
    WA/Call volumes) and also keep the raw rows for future tabs."""
    if raw.empty:
        return {"summary": {}, "per_agent": [], "raw": {"cols": [], "rows": []}}
    cols = list(raw.columns)
    name_col = cols[0]
    ec_col = "EC%" if "EC%" in cols else next((c for c in cols if c.upper() == "EC"), None)
    bc_col = "BC%" if "BC%" in cols else next((c for c in cols if c.upper() == "BC"), None)
    summary = {}
    if ec_col is not None:
        ec_vals = to_numeric(raw[ec_col])
        summary["avg_ec"] = round(float(ec_vals.mean()), 1)
    if bc_col is not None:
        bc_vals = to_numeric(raw[bc_col])
        summary["avg_bc"] = round(float(bc_vals.mean()), 1)
    summary["total_volume"] = int(len(raw))
    if "Queue" in cols:
        summary["wa_volume"] = int(len(raw[raw["Queue"].str.contains("WhatsApp", case=False, na=False)]))
        summary["call_volume"] = int(len(raw[raw["Queue"].str.contains("Call", case=False, na=False)]))
    else:
        summary["wa_volume"] = 0
        summary["call_volume"] = 0
    per_agent = []
    if ec_col is not None and bc_col is not None:
        q = raw.copy()
        q["EC_num"] = to_numeric(q[ec_col])
        q["BC_num"] = to_numeric(q[bc_col])
        agg = q.groupby(name_col, as_index=False)[["EC_num", "BC_num"]].mean()
        for r in agg.itertuples(index=False):
            per_agent.append({"agent": r[0], "ec": round(float(r[1]), 1), "bc": round(float(r[2]), 1)})
    return {"summary": summary, "per_agent": per_agent, "raw": rows_to_columnar(raw)}


def main():
    os.makedirs(OUT, exist_ok=True)
    print(f"Output dir: {OUT}")

    keys = list(SHEET_GIDS.keys())
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(load_csv, SHEET_GIDS[k]): k for k in keys}
        raw = {}
        for f in concurrent.futures.as_completed(futs):
            k = futs[f]
            try:
                raw[k] = f.result()
                print(f"  fetched {k}: {len(raw[k])} rows")
            except Exception as e:
                print(f"  FAILED {k}: {e}")
                sys.exit(1)

    df_merchant = process_ticket_df(raw["merchant_support"])
    df_client = process_ticket_df(raw["client_support"])
    for d in (df_merchant, df_client):
        if not d.empty and "Closed time" in d.columns:
            d["Ticket_Status"] = pd.to_datetime(d["Closed time"], errors="coerce").notna().map({True: "Closed", False: "Open"})
        if not d.empty and "Project" in d.columns:
            d["Project"] = d["Project"].replace(PROJECT_RENAME)

    df_merchant["_team"] = "merchant"
    df_client["_team"] = "client"
    df_all = pd.concat([df_merchant, df_client], ignore_index=True)

    date_col = next((c for c in df_all.columns if any(k in c.lower() for k in ["created", "date"])), None)
    tickets = rows_to_columnar(df_all, drop=("Month_Name", "Month_Num"))

    def opt_list(col):
        if col not in df_all.columns:
            return []
        return sorted(df_all[col].dropna().astype(str).str.strip().unique().tolist())

    meta = {
        "build": datetime.now(TZ).strftime("%Y%m%d%H%M%S"),
        "updated": datetime.now(TZ).strftime("%d %b %Y %H:%M"),
        "updated_iso": datetime.now(TZ).isoformat(),
        "counts": {
            "merchant": int(len(df_merchant)),
            "client": int(len(df_client)),
            "all": int(len(df_all)),
        },
        "date_min": str(df_all["D_Obj"].min()) if not df_all.empty else "",
        "date_max": str(df_all["D_Obj"].max()) if not df_all.empty else "",
        "date_col": date_col,
        "filters": {
            "Merchant": opt_list("Merchant"),
            "Project": opt_list("Project"),
            "Branch User Name": opt_list("Branch User Name"),
            "District": opt_list("District"),
            "Ticket type": opt_list("Ticket type"),
            "Ticket subtype": opt_list("Ticket subtype"),
            "Call Microtype": opt_list("Call Microtype"),
            "Action taken": opt_list("Action taken"),
        },
        "quality": parse_quality_board(raw["quality_board"]),
        "sheet_cols": {k: list(v.columns) for k, v in raw.items()},
    }

    agent = build_agent(raw["agent_perf"])
    sla = rows_to_columnar(raw["inbound_sla"])
    redemption = rows_to_columnar(raw["redemption"])

    def write_json(name, obj, gzip_level=9):
        path = os.path.join(OUT, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(clean_json(obj), f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        size = os.path.getsize(path)
        gz_path = path + ".gz"
        with open(path, "rb") as f:
            gz = gzip.compress(f.read(), gzip_level)
        with open(gz_path, "wb") as f:
            f.write(gz)
        gz_size = len(gz)
        print(f"  {name}: {size/1024:.0f} KB (gz {gz_size/1024:.0f} KB)")
        return size, gz_size

    sizes = {}
    sizes["meta.json"] = write_json("meta.json", meta)
    sizes["tickets.json"] = write_json("tickets.json", tickets)
    sizes["agent.json"] = write_json("agent.json", agent)
    sizes["sla.json"] = write_json("sla.json", sla)
    sizes["redemption.json"] = write_json("redemption.json", redemption)

    total = sum(s[0] for s in sizes.values())
    total_gz = sum(s[1] for s in sizes.values())
    print(f"TOTAL: {total/1024:.0f} KB  (gz {total_gz/1024:.0f} KB)")

    stamp_index(meta["build"])
    print("Done.")


def stamp_index(build_ts):
    """Replace the DS_BUILD cache-busting marker in web/index.html so every build
    stamps a fresh version on styles.css/app.js (and window.DS_BUILD), which keeps
    browsers off stale cached assets."""
    path = os.path.join(ROOT, "web", "index.html")
    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
        if "DS_BUILD=" in html:
            html = re.sub(r"DS_BUILD='[^']*'", f"DS_BUILD='{build_ts}'", html)
            html = re.sub(r"\?v=[^\"']*", f"?v={build_ts}", html)
            with open(path, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"  stamped web/index.html build={build_ts}")
        else:
            print("  web/index.html: no DS_BUILD marker to stamp")
    except Exception as e:
        print(f"  WARN could not stamp index.html: {e}")


if __name__ == "__main__":
    main()
