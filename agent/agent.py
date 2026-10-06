"""
ProofSec — demo offline do "cérebro" do agente (Python puro, sem AWS).

Usa exatamente os mesmos módulos da Lambda (policy / llm / scope), então o que
você vê aqui é o que roda em produção. Para abrir o escrow on-chain de verdade,
use o executor: `cd agent && npm run executor`.

    python agent/agent.py                      # alerta MEDIUM (dentro do teto)
    python agent/agent.py --severity 8.5       # HIGH (exige humano)
    ANTHROPIC_API_KEY=... python agent/agent.py  # escopo redigido pela LLM
"""
import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend-serverless", "functions"))

from common.llm import generate_scope  # noqa: E402
from common.policy import MAX_AGENT_SPENDING_LIMIT_USDC, decide, recommend  # noqa: E402
from common.scope import build_scope_document, new_job_id, scope_hash  # noqa: E402


def main():
    # Consoles Windows (cp1252) quebram com "→"/"—"; força UTF-8 na saída.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--severity", default="5.0", help="0-10 (GuardDuty) ou LOW/MEDIUM/HIGH/CRITICAL")
    ap.add_argument("--target", default="api.company-production.com")
    ap.add_argument("--type", default="UnauthorizedAccess:EC2/ExposedEndpoint")
    args = ap.parse_args()

    print("=" * 64)
    print("  PROOFSEC - AGENTE DE SEGURANÇA (demo offline)")
    print("=" * 64)

    finding = {"source": "demo", "type": args.type, "severity": args.severity,
               "resource": args.target, "description": "Alerta sintético para demonstração"}
    print(f"\n[1] Alerta recebido: {finding['type']} em {finding['resource']} (sev {finding['severity']})")

    rec = recommend(finding["severity"])
    print(f"[2] Policy Engine (determinístico): severidade {rec['severity']} → "
          f"{rec['budgetUsdc']:.2f} USDC, prazo {rec['deadlineDays']} dias")

    scope = generate_scope(finding)
    print(f"[3] Escopo redigido por: {scope.get('generatedBy')}")
    print(f"    Título: {scope['title']}")
    for step in scope["testPlan"]:
        print(f"    - {step}")

    job_id = new_job_id("ag")
    doc = build_scope_document(job_id=job_id, client_wallet="<carteira-da-empresa>", title=scope["title"],
                               targets=scope["targets"], budget_usdc=rec["budgetUsdc"],
                               deadline_days=rec["deadlineDays"], review_hours=72,
                               test_plan=scope["testPlan"], source="agent:demo")
    print(f"[4] scope_hash (vai on-chain como autorização de teste): {scope_hash(doc)}")

    decision = decide(rec["budgetUsdc"])
    print(f"\n[5] Decisão: {decision['status']} (teto autônomo {MAX_AGENT_SPENDING_LIMIT_USDC:.2f} USDC)")
    print(f"    {decision['reason']}")
    if decision["autonomous"]:
        print("    → O executor assina initialize_job_by_agent; a AgentPolicy on-chain revalida os limites.")
    else:
        print("    → Proposta aparece no painel da empresa para assinatura no Phantom.")

    report = b"PROOFSEC AUDIT REPORT (cifrado): PoC + remediacao"
    sha = hashlib.sha256(report).hexdigest()
    print(f"\n[6] Pesquisador entrega relatório cifrado; SHA-256 on-chain: {sha}")
    print("[7] Cliente baixa, recalcula o hash no navegador, confere com a chain e aprova "
          "(ou o pagamento sai sozinho ao fim da janela de revisão).")
    print("\nJSON da proposta:")
    print(json.dumps({"jobId": job_id, "status": decision["status"], "scopeDocument": doc}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
