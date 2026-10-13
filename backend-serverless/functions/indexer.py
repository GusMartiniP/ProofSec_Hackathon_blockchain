"""
Indexador agendado: lê todos os JobAccounts do programa e espelha no DynamoDB,
e vigia a conta Config (alerta quando taxa/árbitro/tesouraria/admin mudam).

Roda a cada minuto (EventBridge Scheduler). Para produção, troque/complemente
por um webhook da Helius disparado pelos eventos do programa.
"""
import hashlib
import json

from common import alerts, db, log
from common.solana import fetch_all_jobs, fetch_config
from common.sync import apply_onchain

_TRACKED = ("onchainStatus", "evidenceSha256", "researcherWallet", "disputeDeadline")


def _changed(item: dict | None, onchain: dict) -> bool:
    if not item or item.get("status") != "ONCHAIN":
        return True
    current = {
        "onchainStatus": onchain["status"],
        "evidenceSha256": onchain["evidenceSha256"],
        "researcherWallet": onchain["researcher"],
        "disputeDeadline": onchain["disputeDeadline"] or None,
    }
    return any(item.get(k) != current[k] for k in _TRACKED)


def _watch_config() -> None:
    cfg = fetch_config()
    if not cfg:
        return
    fingerprint = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
    previous = db.get_meta("config")
    if previous and previous.get("fingerprint") != fingerprint:
        alerts.alert("On-chain config changed", severity="CRITICAL", config=cfg,
                     action="Confirm that the change was approved (AGENTS.md §5).")
    if not previous or previous.get("fingerprint") != fingerprint:
        db.put_meta("config", {"fingerprint": fingerprint, "config": json.dumps(cfg, sort_keys=True)})


def handler(event, context):
    jobs = fetch_all_jobs()
    updated = 0
    for onchain in jobs:
        try:
            item = db.get_job(onchain["jobId"])
            if not _changed(item, onchain):
                continue
            apply_onchain(onchain, item)
            updated += 1
        except Exception as e:  # noqa: BLE001 - um job ruim não derruba a rodada
            log.error("indexer_item_failed", jobPda=onchain.get("jobPda"), error=type(e).__name__)
    try:
        _watch_config()
    except Exception as e:  # noqa: BLE001
        log.error("indexer_config_watch_failed", error=type(e).__name__)
    log.info("indexer_run", total=len(jobs), updated=updated)
    return {"total": len(jobs), "updated": updated}
