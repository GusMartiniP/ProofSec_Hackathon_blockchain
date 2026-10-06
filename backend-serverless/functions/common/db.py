"""Acesso ao DynamoDB concentrado num só lugar (facilita testes e revisão de IAM)."""
import os
import time

import boto3
from boto3.dynamodb.conditions import Key

_dynamodb = boto3.resource("dynamodb")
jobs_table = _dynamodb.Table(os.environ.get("JOBS_TABLE", "ProofSec-Jobs"))
users_table = _dynamodb.Table(os.environ.get("USERS_TABLE", "ProofSec-Users"))
nonces_table = _dynamodb.Table(os.environ.get("NONCES_TABLE", "ProofSec-Nonces"))


def _clean(item: dict) -> dict:
    # DynamoDB não aceita string vazia em chaves de índice; remove Nones.
    return {k: v for k, v in item.items() if v is not None}


# ---------------- Jobs ----------------

def get_job(job_id: str):
    return jobs_table.get_item(Key={"jobId": job_id}).get("Item")


def put_job(item: dict, only_if_new: bool = False):
    item = _clean({**item, "updatedAt": int(time.time())})
    kwargs = {"Item": item}
    if only_if_new:
        kwargs["ConditionExpression"] = "attribute_not_exists(jobId)"
    jobs_table.put_item(**kwargs)
    return item


def _conditional_failed(error: Exception) -> bool:
    return "ConditionalCheckFailed" in type(error).__name__ or "ConditionalCheckFailed" in str(error)


def put_job_once(item: dict):
    """Cria de forma idempotente; retorna None se a chave já existir."""
    try:
        return put_job(item, only_if_new=True)
    except Exception as e:  # noqa: BLE001 - boto3 e os fakes usam classes diferentes
        if _conditional_failed(e):
            return None
        raise


def add_applicant(job_id: str, wallet: str, max_applicants: int):
    """Adiciona uma candidatura sem substituir campos sincronizados concorrentemente."""
    try:
        response = jobs_table.update_item(
            Key={"jobId": job_id},
            UpdateExpression=(
                "SET applicants = list_append(if_not_exists(applicants, :empty), :one), "
                "updatedAt = :now"
            ),
            ConditionExpression=(
                "#status = :onchain AND onchainStatus = :open "
                "AND attribute_not_exists(researcherWallet) "
                "AND (attribute_not_exists(applicants) OR "
                "(NOT contains(applicants, :wallet) AND size(applicants) < :max))"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":empty": [],
                ":one": [wallet],
                ":wallet": wallet,
                ":now": int(time.time()),
                ":onchain": "ONCHAIN",
                ":open": "OPEN",
                ":max": max_applicants,
            },
            ReturnValues="ALL_NEW",
        )
        return response.get("Attributes")
    except Exception as e:  # noqa: BLE001
        if _conditional_failed(e):
            return None
        raise


def _query_all(*, index_name: str, key_name: str, key_value: str) -> list[dict]:
    """Percorre todas as paginas de uma GSI sem descartar itens silenciosamente."""
    items = []
    last_key = None
    while True:
        kwargs = {
            "IndexName": index_name,
            "KeyConditionExpression": Key(key_name).eq(key_value),
        }
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        res = jobs_table.query(**kwargs)
        items.extend(res.get("Items", []))
        last_key = res.get("LastEvaluatedKey")
        if not last_key:
            return items


def list_jobs_by_status(status: str):
    return _query_all(index_name="StatusIndex", key_name="status", key_value=status)


def list_jobs_by_client(wallet: str):
    return _query_all(index_name="ClientIndex", key_name="clientWallet", key_value=wallet)


def list_jobs_by_researcher(wallet: str):
    return _query_all(index_name="ResearcherIndex", key_name="researcherWallet", key_value=wallet)


# ---------------- Users ----------------

def get_user(wallet: str):
    return users_table.get_item(Key={"wallet": wallet}).get("Item")


def put_user(item: dict):
    item = _clean({**item, "updatedAt": int(time.time())})
    users_table.put_item(Item=item)
    return item


# ---------------- Metadados internos (na tabela Users, chave "meta#<nome>") ----------------

def get_meta(name: str):
    return users_table.get_item(Key={"wallet": f"meta#{name}"}).get("Item")


def put_meta(name: str, data: dict):
    users_table.put_item(Item=_clean({**data, "wallet": f"meta#{name}", "updatedAt": int(time.time())}))


# ---------------- Nonces de login (PS-09: um item por nonce, com TTL) ----------------

def put_nonce(nonce: str, wallet: str, message: str, expires_at: int):
    nonces_table.put_item(
        Item={"nonce": nonce, "wallet": wallet, "message": message, "expiresAt": expires_at},
        ConditionExpression="attribute_not_exists(nonce)",
    )


def get_nonce(nonce: str):
    return nonces_table.get_item(Key={"nonce": nonce}).get("Item")


def consume_nonce(nonce: str) -> bool:
    """Apaga o nonce de forma atômica. False se já foi usado (replay/corrida)."""
    try:
        nonces_table.delete_item(Key={"nonce": nonce}, ConditionExpression="attribute_exists(nonce)")
        return True
    except Exception as e:  # noqa: BLE001 - ConditionalCheckFailedException
        if _conditional_failed(e):
            return False
        raise
