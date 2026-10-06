pub const CONFIG_SEED: &[u8] = b"config";
pub const JOB_SEED: &[u8] = b"job";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POLICY_SEED: &[u8] = b"policy";

pub const BPS_DENOMINATOR: u64 = 10_000;
/// Taxa máxima da plataforma: 10%.
pub const MAX_FEE_BPS: u16 = 1_000;

pub const MAX_JOB_ID_LEN: usize = 32;

/// Prazo mínimo de um job (10 min, curto de propósito para a demo).
pub const MIN_JOB_DURATION: i64 = 10 * 60;
/// Prazo máximo de um job (180 dias).
pub const MAX_JOB_DURATION: i64 = 180 * 24 * 60 * 60;

/// Janela de revisão mínima (60 s, para a demo) e máxima (30 dias).
pub const MIN_REVIEW_PERIOD: i64 = 60;
pub const MAX_REVIEW_PERIOD: i64 = 30 * 24 * 60 * 60;

/// Jobs abertos pelo agente exigem janela de revisão maior (PS-05 / ADR-016):
/// dá tempo para a empresa notar uma entrega suspeita e contestar.
pub const MIN_AGENT_REVIEW_PERIOD: i64 = 72 * 60 * 60;

/// Prazo para o árbitro decidir uma disputa (PS-02 / ADR-013).
/// Mínimo curto para a demo; máximo de 30 dias.
pub const MIN_DISPUTE_PERIOD: i64 = 60;
pub const MAX_DISPUTE_PERIOD: i64 = 30 * 24 * 60 * 60;

/// Carência da recuperação de último recurso (PS-37 / ADR-021): depois do fim da janela de revisão
/// (ou do prazo do árbitro) mais este tempo, qualquer pessoa devolve o saldo do vault ao cliente.
pub const RECOVERY_GRACE_PERIOD: i64 = 30 * 24 * 60 * 60;

/// Divisão aplicada quando o árbitro não decide dentro do prazo: 50% para cada lado.
pub const DISPUTE_TIMEOUT_RESEARCHER_BPS: u64 = 5_000;
