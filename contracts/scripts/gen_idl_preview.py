#!/usr/bin/env python3
"""
Gera um IDL *provisório* (spec Anchor 0.1.0) espelhando programs/proofsec/src.

Por que existe: permite que frontend e agente funcionem/compilem antes do
primeiro `anchor build`. Assim que você rodar `anchor build`, o hook
`post_build` (scripts/sync-idl.mjs) sobrescreve este arquivo com o IDL real
gerado pelo Anchor — que é sempre a fonte da verdade.

Uso:
  python3 scripts/gen_idl_preview.py           # gera frontend/src/idl e agent/idl
  python3 scripts/gen_idl_preview.py --check   # só confere este spec contra o lib.rs
"""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parent
SRC = ROOT / "programs/proofsec/src"
PROGRAM_ID = "PrfSec1111111111111111111111111111111111111"

SYSTEM = "11111111111111111111111111111111"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def disc(prefix: str, name: str):
    return list(hashlib.sha256(f"{prefix}:{name}".encode()).digest()[:8])


def acc(name, w=False, s=False, address=None):
    a = {"name": name}
    if w:
        a["writable"] = True
    if s:
        a["signer"] = True
    if address:
        a["address"] = address
    return a


SYS = acc("system_program", address=SYSTEM)
TOK = acc("token_program", address=TOKEN)
H32 = {"array": ["u8", 32]}

JOB_ARGS = [
    {"name": "job_id", "type": "string"},
    {"name": "amount", "type": "u64"},
    {"name": "deadline", "type": "i64"},
    {"name": "review_period", "type": "i64"},
    {"name": "scope_hash", "type": H32},
]

CONFIG_ARGS = [
    {"name": "arbiter", "type": "pubkey"},
    {"name": "treasury", "type": "pubkey"},
    {"name": "fee_bps", "type": "u16"},
    {"name": "allowed_mint", "type": "pubkey"},
    {"name": "dispute_period", "type": "i64"},
]

# Contas compartilhadas pela liquidação de disputa (árbitro e timeout)
DISPUTE_TAIL = [
    acc("job_account", w=True), acc("vault", w=True), acc("mint"),
    acc("client"), acc("client_token_account", w=True),
    acc("researcher"), acc("researcher_token_account", w=True),
    acc("treasury"), acc("treasury_token_account", w=True),
    acc("rent_payer", w=True), TOK,
]

REFUND_ACCOUNTS = [
    acc("job_account", w=True), acc("vault", w=True), acc("mint"), acc("client", s=True),
    acc("client_token_account", w=True), acc("rent_payer", w=True), TOK,
]

# Ordem das contas = ordem dos campos nas structs #[derive(Accounts)] do lib.rs
# (nome da instrução, struct, contas, args)
INSTRUCTIONS = [
    ("initialize_config", "InitializeConfig", [
        acc("config", w=True), acc("admin", w=True, s=True),
        acc("program", address=PROGRAM_ID), acc("program_data"), SYS,
    ], CONFIG_ARGS),
    ("update_config", "UpdateConfig", [acc("config", w=True), acc("admin", s=True)],
     [{"name": "new_admin", "type": "pubkey"}] + CONFIG_ARGS),
    ("set_agent_policy", "SetAgentPolicy", [acc("policy", w=True), acc("owner", w=True, s=True), SYS], [
        {"name": "agent", "type": "pubkey"},
        {"name": "max_per_job", "type": "u64"},
        {"name": "max_per_period", "type": "u64"},
        {"name": "period_seconds", "type": "i64"},
        {"name": "active", "type": "bool"},
    ]),
    ("initialize_job", "InitializeJob", [
        acc("config"), acc("job_account", w=True), acc("vault", w=True), acc("client", w=True, s=True),
        acc("client_token_account", w=True), acc("mint"), TOK, SYS,
    ], JOB_ARGS + [{"name": "researcher", "type": "pubkey"}]),
    ("initialize_job_by_agent", "InitializeJobByAgent", [
        acc("config"), acc("policy", w=True), acc("agent", w=True, s=True), acc("owner"),
        acc("job_account", w=True), acc("vault", w=True), acc("owner_token_account", w=True),
        acc("mint"), TOK, SYS,
    ], JOB_ARGS),
    ("assign_researcher", "AssignResearcher", [acc("job_account", w=True), acc("client", s=True)],
     [{"name": "researcher", "type": "pubkey"}]),
    ("accept_job", "AcceptJob", [acc("job_account", w=True), acc("researcher", s=True)], []),
    ("submit_evidence", "SubmitEvidence", [acc("job_account", w=True), acc("researcher", s=True)],
     [{"name": "evidence_sha256", "type": H32}]),
    ("approve_and_release", "ApproveAndRelease", [
        acc("config"), acc("job_account", w=True), acc("vault", w=True), acc("mint"),
        acc("client", s=True), acc("researcher"), acc("researcher_token_account", w=True),
        acc("treasury"), acc("treasury_token_account", w=True), acc("rent_payer", w=True), TOK,
    ], []),
    ("claim_after_review", "ClaimAfterReview", [
        acc("config"), acc("job_account", w=True), acc("vault", w=True), acc("mint"),
        acc("researcher", s=True), acc("researcher_token_account", w=True),
        acc("treasury"), acc("treasury_token_account", w=True), acc("rent_payer", w=True), TOK,
    ], []),
    ("open_dispute", "OpenDispute", [acc("job_account", w=True), acc("client", s=True)], []),
    ("resolve_dispute", "ResolveDispute", [acc("config"), acc("arbiter", s=True)] + DISPUTE_TAIL,
     [{"name": "researcher_bps", "type": "u16"}]),
    ("resolve_dispute_timeout", "ResolveDisputeTimeout", [acc("config")] + DISPUTE_TAIL, []),
    ("refund_expired", "RefundJob", REFUND_ACCOUNTS, []),
    ("cancel_job", "RefundJob", REFUND_ACCOUNTS, []),
    ("recover_stuck_funds", "RecoverStuckFunds", [
        acc("job_account", w=True), acc("vault", w=True), acc("mint"), acc("client"),
        acc("client_token_account", w=True), acc("rent_payer", w=True), TOK,
    ], []),
]

TYPES = {
    "Config": [
        ("admin", "pubkey"), ("arbiter", "pubkey"), ("treasury", "pubkey"),
        ("fee_bps", "u16"), ("allowed_mint", "pubkey"), ("dispute_period", "i64"), ("bump", "u8"),
    ],
    "JobAccount": [
        ("client", "pubkey"), ("researcher", "pubkey"), ("mint", "pubkey"), ("vault", "pubkey"),
        ("amount", "u64"), ("deadline", "i64"), ("review_period", "i64"), ("review_deadline", "i64"),
        ("scope_hash", H32), ("evidence_sha256", H32),
        ("status", {"defined": {"name": "JobStatus"}}), ("created_by_agent", "bool"),
        ("bump", "u8"), ("vault_bump", "u8"), ("arbiter", "pubkey"), ("rent_payer", "pubkey"),
        ("fee_bps", "u16"), ("dispute_period", "i64"), ("dispute_deadline", "i64"), ("treasury", "pubkey"),
        ("job_id", "string"),
    ],
    "AgentPolicy": [
        ("owner", "pubkey"), ("agent", "pubkey"), ("max_per_job", "u64"), ("max_per_period", "u64"),
        ("period_seconds", "i64"), ("period_start", "i64"), ("spent_in_period", "u64"),
        ("active", "bool"), ("bump", "u8"),
    ],
    # Eventos
    "ConfigUpdated": [
        ("admin", "pubkey"), ("arbiter", "pubkey"), ("treasury", "pubkey"), ("fee_bps", "u16"),
        ("allowed_mint", "pubkey"), ("dispute_period", "i64"),
    ],
    "JobCreated": [
        ("job", "pubkey"), ("client", "pubkey"), ("researcher", "pubkey"), ("mint", "pubkey"),
        ("amount", "u64"), ("deadline", "i64"), ("scope_hash", H32), ("arbiter", "pubkey"),
        ("fee_bps", "u16"), ("created_by_agent", "bool"),
    ],
    "ResearcherAssigned": [("job", "pubkey"), ("researcher", "pubkey")],
    "JobAccepted": [("job", "pubkey"), ("researcher", "pubkey")],
    "EvidenceSubmitted": [
        ("job", "pubkey"), ("researcher", "pubkey"), ("evidence_sha256", H32), ("review_deadline", "i64"),
    ],
    "JobReleased": [
        ("job", "pubkey"), ("researcher", "pubkey"), ("researcher_amount", "u64"), ("fee", "u64"),
        ("auto_released", "bool"),
    ],
    "DisputeOpened": [("job", "pubkey"), ("client", "pubkey"), ("dispute_deadline", "i64")],
    "DisputeResolved": [
        ("job", "pubkey"), ("researcher_bps", "u16"), ("researcher_amount", "u64"),
        ("client_amount", "u64"), ("fee", "u64"), ("timed_out", "bool"),
    ],
    "JobRefunded": [("job", "pubkey"), ("client", "pubkey"), ("amount", "u64"), ("cancelled", "bool")],
    "JobRecovered": [("job", "pubkey"), ("client", "pubkey"), ("amount", "u64"), ("from_dispute", "bool")],
    "AgentPolicyUpdated": [
        ("policy", "pubkey"), ("owner", "pubkey"), ("agent", "pubkey"), ("max_per_job", "u64"),
        ("max_per_period", "u64"), ("period_seconds", "i64"), ("active", "bool"),
    ],
}
ACCOUNTS = ["AgentPolicy", "Config", "JobAccount"]
EVENTS = [
    "AgentPolicyUpdated", "ConfigUpdated", "DisputeOpened", "DisputeResolved", "EvidenceSubmitted",
    "JobAccepted", "JobCreated", "JobRecovered", "JobRefunded", "JobReleased", "ResearcherAssigned",
]
JOB_STATUS = [
    "Open", "InProgress", "EvidenceSubmitted", "Disputed", "Completed", "Resolved", "Refunded", "Cancelled",
]


def parse_errors():
    src = (SRC / "errors.rs").read_text(encoding="utf-8")
    pairs = re.findall(r'#\[msg\("([^"]*)"\)\]\s*(\w+),', src)
    return [{"code": 6000 + i, "name": n, "msg": m} for i, (m, n) in enumerate(pairs)]


def build():
    types = [
        {"name": n, "type": {"kind": "struct", "fields": [{"name": f, "type": t} for f, t in fields]}}
        for n, fields in TYPES.items()
    ]
    types.append({"name": "JobStatus", "type": {"kind": "enum", "variants": [{"name": v} for v in JOB_STATUS]}})
    types.sort(key=lambda t: t["name"])
    return {
        "address": PROGRAM_ID,
        "metadata": {
            "name": "proofsec",
            "version": "0.3.0",
            "spec": "0.1.0",
            "description": "PREVIEW gerado por scripts/gen_idl_preview.py - substituido pelo IDL real no anchor build",
        },
        "instructions": [
            {"name": n, "discriminator": disc("global", n), "accounts": a, "args": args}
            for n, _s, a, args in sorted(INSTRUCTIONS, key=lambda x: x[0])
        ],
        "accounts": [{"name": n, "discriminator": disc("account", n)} for n in ACCOUNTS],
        "events": [{"name": n, "discriminator": disc("event", n)} for n in EVENTS],
        "errors": parse_errors(),
        "types": types,
    }


# ---------------------------------------------------------------- verificação

def _rust_structs(src: str):
    """Extrai, de cada #[derive(Accounts)], a lista (campo, writable, signer)."""
    out = {}
    for m in re.finditer(r"#\[derive\(Accounts\)\]\s*(?:#\[instruction\([^\]]*\)\]\s*)?pub struct (\w+)<'info> \{(.*?)\n\}", src, re.S):
        name, body = m.group(1), m.group(2)
        fields, attr_buf = [], []
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("#[account") or attr_buf and not stripped.startswith("pub "):
                attr_buf.append(stripped)
                continue
            fm = re.match(r"pub (\w+): (\w+)<", stripped)
            if fm:
                attrs = " ".join(attr_buf)
                tokens = set(re.findall(r"[A-Za-z_]+", attrs.split("#[account(", 1)[-1])) if attrs else set()
                writable = bool(tokens & {"mut", "init", "init_if_needed"})
                fields.append((fm.group(1), writable, fm.group(2) == "Signer"))
                attr_buf = []
        out[name] = fields
    return out


def _rust_handlers(src: str):
    return dict(re.findall(r"pub fn (\w+)\(\s*ctx: Context<(\w+)>", src))


def _rust_struct_fields(src: str, name: str):
    m = re.search(rf"pub struct {name} \{{(.*?)\n\}}", src, re.S)
    return re.findall(r"pub (\w+):", m.group(1)) if m else []


def check() -> list[str]:
    lib = (SRC / "lib.rs").read_text(encoding="utf-8")
    state = (SRC / "state.rs").read_text(encoding="utf-8")
    events = (SRC / "events.rs").read_text(encoding="utf-8")
    problems = []
    structs, handlers = _rust_structs(lib), _rust_handlers(lib)
    spec_names = {n for n, *_ in INSTRUCTIONS}
    if set(handlers) != spec_names:
        problems.append(f"instruções divergentes: rust={sorted(set(handlers) - spec_names)} spec={sorted(spec_names - set(handlers))}")
    for name, struct, accounts, args in INSTRUCTIONS:
        if handlers.get(name) != struct:
            problems.append(f"{name}: struct esperada {struct}, rust usa {handlers.get(name)}")
            continue
        rust = structs.get(struct, [])
        if [f for f, *_ in rust] != [a["name"] for a in accounts]:
            problems.append(f"{name}: ordem/nomes das contas divergem\n  rust={[f for f, *_ in rust]}\n  spec={[a['name'] for a in accounts]}")
            continue
        for (f, w, s), a in zip(rust, accounts):
            if w != bool(a.get("writable")) or s != bool(a.get("signer")):
                problems.append(f"{name}.{f}: rust writable={w} signer={s}, spec={a}")
        # argumentos
        sig = re.search(rf"pub fn {name}\((.*?)\) -> Result", lib, re.S).group(1)
        rust_args = re.findall(r"(\w+): ([\w\[\]; 0-9]+)", sig.split(">,", 1)[1] if ">," in sig else "")
        if [n for n, _ in rust_args] != [a["name"] for a in args]:
            problems.append(f"{name}: args divergem rust={[n for n, _ in rust_args]} spec={[a['name'] for a in args]}")
    for tname in ("Config", "JobAccount", "AgentPolicy"):
        rust_fields = _rust_struct_fields(state, tname)
        if rust_fields != [f for f, _ in TYPES[tname]]:
            problems.append(f"campos de {tname} divergem\n  rust={rust_fields}\n  spec={[f for f, _ in TYPES[tname]]}")
    for ev in EVENTS:
        rust_fields = _rust_struct_fields(events, ev)
        if rust_fields != [f for f, _ in TYPES[ev]]:
            problems.append(f"campos do evento {ev} divergem rust={rust_fields} spec={[f for f, _ in TYPES[ev]]}")
    rust_events = set(re.findall(r"#\[event\]\s*pub struct (\w+)", events))
    if rust_events != set(EVENTS):
        problems.append(f"eventos divergem: {rust_events ^ set(EVENTS)}")
    rust_status = re.findall(r"^\s*(\w+),", re.search(r"pub enum JobStatus \{(.*?)\}", state, re.S).group(1), re.M)
    if rust_status != JOB_STATUS:
        problems.append(f"JobStatus diverge: {rust_status}")
    return problems


if __name__ == "__main__":
    if "--check" in sys.argv:
        issues = check()
        for i in issues:
            print("DIVERGÊNCIA:", i)
        print("ok: spec do IDL confere com o lib.rs" if not issues else f"{len(issues)} divergência(s)")
        sys.exit(1 if issues else 0)
    idl = json.dumps(build(), indent=2, ensure_ascii=False) + "\n"
    for t in [REPO / "frontend/src/idl/proofsec.json", REPO / "agent/idl/proofsec.json"]:
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_text(idl, encoding="utf-8")
        print("escrito:", t.relative_to(REPO))
