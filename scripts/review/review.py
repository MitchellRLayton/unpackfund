"""Second-model math review for UnpackFund. Standard library only.

Inputs : git diff vs BASE_REF (calc files + reports), the spec's math sections,
         invariant and oracle output from earlier workflow steps.
Output : review-result.json, a PR comment (when on a PR), exit 1 on FAIL.
"""
import json
import os
import subprocess
import sys
import urllib.request

MAX_DIFF_CHARS = 150_000
SPEC_PATH = "docs/platform/platform-spec.yaml"
DIFF_PATHS = [  # the directories of the workflow's paths filter (T-AU-1.1's file list)
    "pipeline/pipeline", "web/lib", "web/components/lenses", "web/workers",
    "docs/platform", "docs/copy-audit",
]

SYSTEM = """You are the math reviewer for UnpackFund, a fund look-through site.
You did not write this code. Check it against the spec, not against what the code seems to intend.

Check, at minimum:
1. Denominators: every weight, coverage and share divides by the quantity the spec names
   (for example stock weight, not gross weight, under the stock-only basis).
2. Order of operations: renormalization happens after fund-of-funds flattening.
3. Units: basis points vs percent vs cents are never mixed.
4. Invariants: company weights sum to 100% (stock basis); pairwise overlap is symmetric and each
   term ≤ min of the two weights; Core ≤ Broad ≤ company count; Percent and Dollars mode give
   identical weights; row order changes nothing; flattening preserves mass within 1 bp;
   an account filter equals that account entered alone.
5. The invariant and oracle outputs provided: any failure or disagreement is a FAIL.
6. For owner reports with before/after tables: do the size and direction of each change follow
   from the formula? Flag any change the formula does not explain.

Reply with JSON only:
{"verdict":"PASS"|"FAIL",
 "checks":[{"id":"short-id","result":"PASS"|"FAIL"|"N/A","evidence":"file:line or table row, one sentence"}],
 "questions_for_owner":["..."]}
FAIL if any check fails. Do not comment on style or naming."""


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=False).stdout


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return f"({path} not found)"


def main() -> int:
    base = os.environ.get("BASE_REF", "origin/main")
    diff = sh("git", "diff", f"{base}...HEAD", "--", *DIFF_PATHS)[:MAX_DIFF_CHARS]
    if not diff.strip():
        print("No relevant diff; skipping model review.")
        return 0

    user = "\n\n".join([
        "## Spec (math sections are portfolio_math, equity_rule, fund_fields_new)\n" + read(SPEC_PATH),
        "## Invariant test output\n" + read("review-invariants.txt"),
        "## Oracle output\n" + read("review-oracle.txt"),
        "## Diff\n" + diff,
    ])

    body = json.dumps({
        "model": os.environ["REVIEW_MODEL"],
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        content = json.load(resp)["choices"][0]["message"]["content"]

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        result = {"verdict": "FAIL", "checks": [{"id": "parse", "result": "FAIL",
                                                 "evidence": "Reviewer did not return JSON."}],
                  "raw": content[:2000]}

    with open("review-result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    lines = [f"## Math review: **{result.get('verdict', 'FAIL')}**", "",
             "| check | result | evidence |", "|---|---|---|"]
    for c in result.get("checks", []):
        lines.append(f"| {c.get('id','')} | {c.get('result','')} | {c.get('evidence','').replace('|','/')} |")
    for q in result.get("questions_for_owner", []):
        lines.append(f"- ❓ {q}")
    comment = "\n".join(lines)
    print(comment)

    if os.environ.get("PR_NUMBER"):
        subprocess.run(["gh", "pr", "comment", os.environ["PR_NUMBER"], "--body", comment], check=False)

    return 0 if result.get("verdict") == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
