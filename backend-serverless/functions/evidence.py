"""
Evidências (relatórios) no S3.

- O relatório é criptografado NO NAVEGADOR antes do upload (só cliente,
  pesquisador e árbitro conseguem abrir). O S3 guarda apenas o blob cifrado.
- A chave do objeto é derivada do hash: reports/<jobId>/<sha256>.bin
- O SHA-256 do blob é o mesmo que vai on-chain em `submit_evidence`.
- Defesa em profundidade: o presigned PUT exige o checksum SHA-256 e a função
  `verify_upload` (evento do S3) recalcula o hash e apaga objetos que não batem.
"""
import base64
import hashlib
import os
import re
from urllib.parse import unquote_plus

import boto3
from botocore.config import Config

from common import alerts, db, log
from common.http import HttpError, auth_wallet, handler, ok, parse_body
from common.sync import evidence_key, sync_job

BUCKET = os.environ.get("REPORTS_BUCKET", "")
MAX_SIZE = 50 * 1024 * 1024
CONTENT_TYPE = "application/octet-stream"
_KEY_RE = re.compile(r"^reports/([a-z0-9]{1,32})/([0-9a-f]{64})\.bin$")


def _s3_client():
    kwargs = {"signature_version": "s3v4"}
    try:
        # boto3 >= 1.36 adiciona checksums CRC32 automáticos em URLs pré-assinadas;
        # desligamos para o navegador não precisar enviá-los.
        cfg = Config(request_checksum_calculation="when_required", **kwargs)
    except TypeError:
        cfg = Config(**kwargs)
    return boto3.client("s3", config=cfg)


s3 = _s3_client()


def _fresh_job(job_id: str) -> dict:
    item = db.get_job(job_id)
    if not item:
        raise HttpError(404, "job not found")
    if item.get("jobPda"):
        item = sync_job(job_id) or item
    return item


@handler
def upload_url(event, context):
    """POST /evidence/upload-url {jobId, sha256Hex, sizeBytes} (pesquisador autenticado)."""
    wallet = auth_wallet(event)
    body = parse_body(event)
    job_id = body.get("jobId")
    sha_value = body.get("sha256Hex")
    if not isinstance(sha_value, str):
        raise HttpError(400, "sha256Hex (64 hex characters) is required")
    sha_hex = sha_value.lower()
    size = body.get("sizeBytes")
    if isinstance(size, bool) or not isinstance(size, int):
        raise HttpError(400, "sizeBytes must be an integer")

    if not isinstance(job_id, str) or not re.fullmatch(r"[a-z0-9]{1,32}", job_id):
        raise HttpError(400, "invalid jobId")
    if not re.fullmatch(r"[0-9a-f]{64}", sha_hex):
        raise HttpError(400, "sha256Hex (64 hex characters) is required")
    if not (0 < size <= MAX_SIZE):
        raise HttpError(400, "file is empty or larger than 50 MB")

    item = _fresh_job(job_id)
    if item.get("onchainStatus") != "IN_PROGRESS":
        raise HttpError(409, "the job must be IN_PROGRESS on-chain")
    if item.get("researcherWallet") != wallet:
        raise HttpError(403, "only the researcher linked on-chain can submit evidence")

    key = evidence_key(job_id, sha_hex)
    checksum_b64 = base64.b64encode(bytes.fromhex(sha_hex)).decode()
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": BUCKET,
            "Key": key,
            "ContentType": CONTENT_TYPE,
            # Faz o tamanho integrar a assinatura SigV4. O navegador envia o
            # Content-Length real do Blob; se divergir, o S3 rejeita o PUT.
            "ContentLength": size,
            "ChecksumSHA256": checksum_b64,
        },
        ExpiresIn=900,
    )
    return ok(
        {
            "success": True,
            "uploadUrl": url,
            "s3Key": key,
            # O navegador precisa enviar exatamente estes headers no PUT
            "headers": {"Content-Type": CONTENT_TYPE, "x-amz-checksum-sha256": checksum_b64},
        }
    )


@handler
def download_url(event, context):
    """POST /evidence/download-url {jobId} (cliente, pesquisador ou árbitro)."""
    wallet = auth_wallet(event)
    job_id = parse_body(event).get("jobId")
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-z0-9]{1,32}", job_id):
        raise HttpError(400, "invalid jobId")

    item = _fresh_job(job_id)
    # Árbitro = o congelado no job on-chain (PS-04), não uma variável de ambiente
    allowed = {item.get("clientWallet"), item.get("researcherWallet"), item.get("arbiterWallet")} - {None, ""}
    if wallet not in allowed:
        log.warning("evidence_download_denied", jobId=job_id, wallet=wallet)
        raise HttpError(403, "no permission for this evidence")
    sha_hex = item.get("evidenceSha256")
    if not sha_hex:
        raise HttpError(409, "no evidence recorded on-chain for this job")

    key = evidence_key(job_id, sha_hex)  # a chave vem do hash on-chain, não do usuário
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
    except Exception as e:  # noqa: BLE001 - botocore e fakes locais usam tipos diferentes
        code = str((getattr(e, "response", {}) or {}).get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"} or str(e) == "404":
            raise HttpError(404, "the evidence file is not in S3 yet")
        log.error("evidence_head_failed", jobId=job_id, error=type(e).__name__)
        raise HttpError(503, "evidence storage temporarily unavailable")
    url = s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=600)
    return ok({"success": True, "downloadUrl": url, "evidenceSha256": sha_hex})


def _remove(bucket: str, key: str, version_id: str | None) -> None:
    # Com versionamento ligado, apagar a versão específica remove o conteúdo de fato
    # (um delete simples só criaria um "delete marker").
    if version_id:
        s3.delete_object(Bucket=bucket, Key=key, VersionId=version_id)
    else:
        s3.delete_object(Bucket=bucket, Key=key)


def verify_upload(event, context):
    """Disparado por s3:ObjectCreated. Recalcula o SHA-256 e apaga se não bater com a chave."""
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        obj = record["s3"]["object"]
        key = unquote_plus(obj["key"])
        version_id = obj.get("versionId")
        m = _KEY_RE.match(key)
        if not m:
            alerts.alert("Non-standard object removed from the reports bucket", key=key)
            _remove(bucket, key, version_id)
            continue
        size = obj.get("size", 0)
        if size > MAX_SIZE:
            alerts.alert("Report above 50 MB removed", key=key, size=size)
            _remove(bucket, key, version_id)
            continue
        h = hashlib.sha256()
        kwargs = {"Bucket": bucket, "Key": key}
        if version_id:
            kwargs["VersionId"] = version_id
        stream = s3.get_object(**kwargs)["Body"]
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
        if h.hexdigest() != m.group(2):
            alerts.alert("Upload with mismatched hash removed", severity="SECURITY_INCIDENT", key=key)
            _remove(bucket, key, version_id)
        else:
            log.info("evidence_verified", key=key)
    return {"ok": True}
