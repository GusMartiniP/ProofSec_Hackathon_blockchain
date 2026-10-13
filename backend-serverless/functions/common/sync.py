"""Reconciliação DynamoDB ← Solana (a chain sempre vence)."""
from . import alerts, db
from .solana import fetch_job


def evidence_key(job_id: str, sha_hex: str) -> str:
    return f"reports/{job_id}/{sha_hex}.bin"


def _notify_transitions(onchain: dict, previous_status: str | None) -> None:
    """Alertas de segurança sobre mudanças relevantes (PS-05)."""
    status, job_id = onchain["status"], onchain["jobId"]
    if status == previous_status:
        return
    if onchain["createdByAgent"] and previous_status is None:
        alerts.alert(
            "Escrow opened by the AI agent",
            jobId=job_id,
            client=onchain["client"],
            amountBase=onchain["amount"],
            action="Review the scope and assign a researcher. A dispute is possible after delivery.",
        )
    if status == "EVIDENCE_SUBMITTED" and onchain["createdByAgent"]:
        alerts.alert(
            "Evidence received on an agent job",
            jobId=job_id,
            reviewDeadline=onchain["reviewDeadline"],
            action="Check the report before the window ends; with no response the payment is released.",
        )
    if status == "DISPUTED":
        alerts.alert(
            "Dispute opened",
            jobId=job_id,
            arbiter=onchain["arbiter"],
            disputeDeadline=onchain["disputeDeadline"],
            action="The arbiter must decide before the deadline; after that the 50/50 split applies.",
        )


def apply_onchain(onchain: dict, item: dict | None) -> dict:
    """Mescla o estado on-chain no item do DynamoDB e salva.

    - Item inexistente: cria um registro mínimo (job criado direto na chain).
    - Item existente com cliente ou scope_hash diferente: NÃO sobrescreve
      (alguém criou um job on-chain com o mesmo job_id) e marca syncError.
    """
    job_id = onchain["jobId"]
    previous_status = (item or {}).get("onchainStatus")
    if item is None:
        item = {
            "jobId": job_id,
            "title": "(job criado diretamente on-chain)",
            "clientWallet": onchain["client"],
            "scopeHash": onchain["scopeHash"],
            "budgetUsdc": str(onchain["amount"] / 1_000_000),
            "createdAt": None,
        }
    elif item.get("clientWallet") != onchain["client"] or item.get("scopeHash") != onchain["scopeHash"]:
        # Outro cliente criou um job on-chain com o mesmo job_id: nunca sobrescrever.
        flag = f"on-chain diverge do draft (pda {onchain['jobPda']})"
        if item.get("syncError") == flag:
            return item  # já sinalizado; evita escrita a cada rodada do indexador
        return db.put_job({**item, "syncError": flag})

    merged = {
        **item,
        "status": "ONCHAIN",
        "onchainStatus": onchain["status"],
        "jobPda": onchain["jobPda"],
        "vault": onchain["vault"],
        "mint": onchain["mint"],
        "amountBase": onchain["amount"],
        "deadline": onchain["deadline"],
        "reviewDeadline": onchain["reviewDeadline"] or None,
        "disputeDeadline": onchain["disputeDeadline"] or None,
        "researcherWallet": onchain["researcher"],
        "arbiterWallet": onchain["arbiter"],
        "treasuryWallet": onchain["treasury"],
        "rentPayer": onchain["rentPayer"],
        "feeBps": onchain["feeBps"],
        "evidenceSha256": onchain["evidenceSha256"],
        "evidenceS3Key": evidence_key(job_id, onchain["evidenceSha256"]) if onchain["evidenceSha256"] else None,
        "createdByAgent": onchain["createdByAgent"],
        "syncError": None,
    }
    # Atribuição definida on-chain encerra as candidaturas
    if onchain["researcher"] or onchain["status"] != "OPEN":
        merged["applicants"] = None
    # Remove chaves None (ex.: pesquisador desatribuído) — put_job substitui o item inteiro
    merged = {k: v for k, v in merged.items() if v is not None}
    saved = db.put_job(merged)
    _notify_transitions(onchain, previous_status)
    return saved


def sync_job(job_id: str, job_pda: str | None = None) -> dict | None:
    item = db.get_job(job_id)
    pda = job_pda or (item or {}).get("jobPda")
    if not pda:
        return item
    onchain = fetch_job(pda)
    if onchain is None:
        return item
    if onchain["jobId"] != job_id:
        raise ValueError("on-chain job_id does not match")
    return apply_onchain(onchain, item)
