"""Prepare an infrastructure-only dev changeset template; no AWS calls.

The live Original SAM template must have been obtained from proofsec-dev in the
reviewed account/Region. Keep every code reference and other resource unchanged.
See docs/aws-hardening-2026-10-12.md; execution belongs to a human.
"""
import copy
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
load = runpy.run_path(str(ROOT / "backend-serverless/scripts/check_template.py"))["load"]


def render(live, desired):
    if live["Parameters"]["Stage"].get("Default") != "dev":
        raise ValueError("Source is not the reviewed dev template")
    for key in ("MonthlyBudget", "Trail", "TrailBucket", "TrailBucketPolicy"):
        if key not in live["Resources"]:
            raise ValueError("Expected existing dev infrastructure absent: " + key)
    result = copy.deepcopy(live)
    result.setdefault("Metadata", {}).setdefault("AWSToolsMetrics", {})["AWSAgentToolkit"] = "aws-cloudformation@3"
    result["Parameters"]["MonthlyCeilingUsd"] = copy.deepcopy(desired["Parameters"]["MonthlyCeilingUsd"])
    result["Resources"]["MonthlyCeilingBudget"] = copy.deepcopy(desired["Resources"]["MonthlyCeilingBudget"])
    trail = result["Resources"]["Trail"]
    trail["Properties"]["IsMultiRegionTrail"] = False
    trail.setdefault("Metadata", {}).update(copy.deepcopy(desired["Resources"]["Trail"]["Metadata"]))
    for key, resource in live["Resources"].items():
        if key != "Trail" and result["Resources"][key] != resource:
            raise ValueError("Unrelated resource changed: " + key)
    return result


if __name__ == "__main__":
    directory = ROOT / ".aws-review"
    live = load(directory / "proofsec-dev-live.yaml")
    desired = load(ROOT / "backend-serverless/template.yaml")
    target = directory / "proofsec-dev-cost-audit.json"
    target.write_text(json.dumps(render(live, desired), separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Prepared {target.name}; no AWS calls; all existing code references preserved.")
