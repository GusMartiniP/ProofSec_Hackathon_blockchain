"""
Segredos em tempo de execução (PS-07).

Em produção cada segredo é um parâmetro SecureString do SSM Parameter Store; a
variável de ambiente `<NOME>_PARAM` traz só o NOME do parâmetro, e o valor é lido
com cache curto (permite rotação sem redeploy). A variável `<NOME>` em texto puro
existe apenas para testes locais.
"""
import os
import time

_CACHE: dict[str, tuple[str, float]] = {}
_TTL_SECONDS = 300
_ssm = None


def _client():
    global _ssm
    if _ssm is None:
        import boto3

        _ssm = boto3.client("ssm")
    return _ssm


def get_secret(param_env: str, plain_env: str | None = None) -> str:
    """Retorna o segredo ou "" se não configurado. Erros de SSM propagam."""
    name = os.environ.get(param_env, "")
    if name:
        cached = _CACHE.get(name)
        if cached and cached[1] > time.time():
            return cached[0]
        value = _client().get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
        _CACHE[name] = (value, time.time() + _TTL_SECONDS)
        return value
    return os.environ.get(plain_env, "") if plain_env else ""


def clear_cache() -> None:
    _CACHE.clear()
