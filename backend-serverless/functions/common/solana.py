"""
Leitura on-chain do programa ProofSec via JSON-RPC (sem dependências).

A Solana é a fonte da verdade do status dos jobs; o DynamoDB só espelha.
Os layouts abaixo precisam bater com `contracts/programs/proofsec/src/state.rs`.
"""
import base64
import hashlib
import json
import os
import struct
import urllib.error
import urllib.request

from . import log
from .b58 import DEFAULT_PUBKEY, b58decode, b58encode

RPC_URLS = [
    u
    for u in (
        os.environ.get("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
        os.environ.get("SOLANA_RPC_URL_FALLBACK", ""),
    )
    if u
]
PROGRAM_ID = os.environ.get("PROGRAM_ID", "PrfSec1111111111111111111111111111111111111")
RPC_TIMEOUT = 10

JOB_DISCRIMINATOR = hashlib.sha256(b"account:JobAccount").digest()[:8]
CONFIG_DISCRIMINATOR = hashlib.sha256(b"account:Config").digest()[:8]
POLICY_DISCRIMINATOR = hashlib.sha256(b"account:AgentPolicy").digest()[:8]

# Mesma ordem do enum JobStatus no contrato.
JOB_STATUS = [
    "OPEN",
    "IN_PROGRESS",
    "EVIDENCE_SUBMITTED",
    "DISPUTED",
    "COMPLETED",
    "RESOLVED",
    "REFUNDED",
    "CANCELLED",
]
ZERO32 = "00" * 32
JOB_FIXED_SIZE = 354  # até o prefixo de tamanho do job_id (inclusive)


class RpcError(Exception):
    pass


class RpcUnavailable(RpcError):
    """Falha de transporte/servidor: vale tentar o próximo RPC."""


def _call(url: str, method: str, params: list):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=RPC_TIMEOUT) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 429 or e.code >= 500:
            raise RpcUnavailable(f"HTTP {e.code}") from e
        raise RpcError(f"HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RpcUnavailable(type(e).__name__) from e
    if "error" in data:
        raise RpcError(str(data["error"]))
    return data["result"]


def rpc(method: str, params: list):
    """Chama o RPC primário; em falha de transporte, tenta o secundário (PS-13)."""
    last: Exception | None = None
    for i, url in enumerate(RPC_URLS):
        try:
            return _call(url, method, params)
        except RpcUnavailable as e:
            last = e
            log.warning("rpc_unavailable", method=method, rpc_index=i, error=str(e))
    raise RpcUnavailable(f"todos os RPCs falharam: {last}")


def _pk(b: bytes) -> str:
    return b58encode(b)


def decode_job(data: bytes) -> dict:
    if len(data) < JOB_FIXED_SIZE or data[:8] != JOB_DISCRIMINATOR:
        raise ValueError("conta não é um JobAccount")
    client, researcher, mint, vault = (_pk(data[8 + i * 32 : 8 + (i + 1) * 32]) for i in range(4))
    amount, deadline, review_period, review_deadline = struct.unpack_from("<Qqqq", data, 136)
    scope_hash = data[168:200].hex()
    evidence = data[200:232].hex()
    status_idx, by_agent, bump, vault_bump = data[232], data[233], data[234], data[235]
    arbiter = _pk(data[236:268])
    rent_payer = _pk(data[268:300])
    (fee_bps,) = struct.unpack_from("<H", data, 300)
    dispute_period, dispute_deadline = struct.unpack_from("<qq", data, 302)
    treasury = _pk(data[318:350])  # congelada no job (PS-37)
    (id_len,) = struct.unpack_from("<I", data, 350)
    if id_len > 32 or len(data) < JOB_FIXED_SIZE + id_len:
        raise ValueError("job_id inválido")
    job_id = data[JOB_FIXED_SIZE : JOB_FIXED_SIZE + id_len].decode("utf-8")
    return {
        "client": client,
        "researcher": None if researcher == DEFAULT_PUBKEY else researcher,
        "mint": mint,
        "vault": vault,
        "amount": amount,
        "deadline": deadline,
        "reviewPeriod": review_period,
        "reviewDeadline": review_deadline,
        "scopeHash": scope_hash,
        "evidenceSha256": None if evidence == ZERO32 else evidence,
        "status": JOB_STATUS[status_idx] if status_idx < len(JOB_STATUS) else f"UNKNOWN_{status_idx}",
        "createdByAgent": bool(by_agent),
        "bump": bump,
        "vaultBump": vault_bump,
        "arbiter": arbiter,
        "rentPayer": rent_payer,
        "feeBps": fee_bps,
        "disputePeriod": dispute_period,
        "disputeDeadline": dispute_deadline,
        "treasury": treasury,
        "jobId": job_id,
    }


def decode_config(data: bytes) -> dict:
    if len(data) < 147 or data[:8] != CONFIG_DISCRIMINATOR:
        raise ValueError("conta não é a Config")
    (fee_bps,) = struct.unpack_from("<H", data, 104)
    (dispute_period,) = struct.unpack_from("<q", data, 138)
    return {
        "admin": _pk(data[8:40]),
        "arbiter": _pk(data[40:72]),
        "treasury": _pk(data[72:104]),
        "feeBps": fee_bps,
        "allowedMint": _pk(data[106:138]),
        "disputePeriod": dispute_period,
    }


def decode_policy(data: bytes) -> dict:
    if len(data) < 113 or data[:8] != POLICY_DISCRIMINATOR:
        raise ValueError("conta não é uma AgentPolicy")
    owner, agent = _pk(data[8:40]), _pk(data[40:72])
    max_job, max_period, period_s, period_start, spent = struct.unpack_from("<QQqqQ", data, 72)
    return {
        "owner": owner,
        "agent": agent,
        "maxPerJob": max_job,
        "maxPerPeriod": max_period,
        "periodSeconds": period_s,
        "periodStart": period_start,
        "spentInPeriod": spent,
        "active": bool(data[112]),
    }


def fetch_job(job_pda: str) -> dict | None:
    """Lê e decodifica um JobAccount. Retorna None se não existir."""
    res = rpc("getAccountInfo", [job_pda, {"encoding": "base64", "commitment": "confirmed"}])
    value = res.get("value")
    if not value:
        return None
    if value["owner"] != PROGRAM_ID:
        raise ValueError("conta não pertence ao programa ProofSec")
    job = decode_job(base64.b64decode(value["data"][0]))
    job["jobPda"] = job_pda
    return job


def _program_accounts(discriminator: bytes) -> list:
    return rpc(
        "getProgramAccounts",
        [
            PROGRAM_ID,
            {
                "encoding": "base64",
                "commitment": "confirmed",
                "filters": [{"memcmp": {"offset": 0, "bytes": b58encode(discriminator)}}],
            },
        ],
    )


def fetch_all_jobs() -> list[dict]:
    jobs = []
    for item in _program_accounts(JOB_DISCRIMINATOR):
        try:
            job = decode_job(base64.b64decode(item["account"]["data"][0]))
            job["jobPda"] = item["pubkey"]
            jobs.append(job)
        except (ValueError, IndexError, UnicodeDecodeError, struct.error) as e:
            log.warning("account_skipped", pubkey=item.get("pubkey"), error=str(e))
    return jobs


def fetch_config() -> dict | None:
    items = _program_accounts(CONFIG_DISCRIMINATOR)
    if not items:
        return None
    cfg = decode_config(base64.b64decode(items[0]["account"]["data"][0]))
    cfg["address"] = items[0]["pubkey"]
    return cfg


def hex32(value: str) -> bytes:
    b = bytes.fromhex(value)
    if len(b) != 32:
        raise ValueError("hash precisa ter 32 bytes")
    return b


__all__ = [
    "RPC_URLS",
    "PROGRAM_ID",
    "JOB_STATUS",
    "RpcError",
    "RpcUnavailable",
    "rpc",
    "decode_job",
    "decode_config",
    "decode_policy",
    "fetch_job",
    "fetch_all_jobs",
    "fetch_config",
    "hex32",
    "b58decode",
]
