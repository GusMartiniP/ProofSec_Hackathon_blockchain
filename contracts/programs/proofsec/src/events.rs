use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub allowed_mint: Pubkey,
    pub dispute_period: i64,
}

#[event]
pub struct JobCreated {
    pub job: Pubkey,
    pub client: Pubkey,
    pub researcher: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub scope_hash: [u8; 32],
    pub arbiter: Pubkey,
    pub fee_bps: u16,
    pub created_by_agent: bool,
}

#[event]
pub struct ResearcherAssigned {
    pub job: Pubkey,
    pub researcher: Pubkey,
}

#[event]
pub struct JobAccepted {
    pub job: Pubkey,
    pub researcher: Pubkey,
}

#[event]
pub struct EvidenceSubmitted {
    pub job: Pubkey,
    pub researcher: Pubkey,
    pub evidence_sha256: [u8; 32],
    pub review_deadline: i64,
}

#[event]
pub struct JobReleased {
    pub job: Pubkey,
    pub researcher: Pubkey,
    pub researcher_amount: u64,
    pub fee: u64,
    /// true = liberado automaticamente após o fim da janela de revisão.
    pub auto_released: bool,
}

#[event]
pub struct DisputeOpened {
    pub job: Pubkey,
    pub client: Pubkey,
    pub dispute_deadline: i64,
}

#[event]
pub struct DisputeResolved {
    pub job: Pubkey,
    pub researcher_bps: u16,
    pub researcher_amount: u64,
    pub client_amount: u64,
    pub fee: u64,
    /// true = árbitro não decidiu no prazo e a divisão padrão foi aplicada.
    pub timed_out: bool,
}

#[event]
pub struct JobRefunded {
    pub job: Pubkey,
    pub client: Pubkey,
    pub amount: u64,
    /// true = cancelado antes do aceite; false = prazo expirado.
    pub cancelled: bool,
}

/// Recuperação de último recurso (PS-37): o saldo voltou inteiro ao cliente depois da carência.
#[event]
pub struct JobRecovered {
    pub job: Pubkey,
    pub client: Pubkey,
    pub amount: u64,
    /// `true` se o job estava em disputa; `false` se estava com evidência submetida.
    pub from_dispute: bool,
}

#[event]
pub struct AgentPolicyUpdated {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_per_job: u64,
    pub max_per_period: u64,
    pub period_seconds: i64,
    pub active: bool,
}
