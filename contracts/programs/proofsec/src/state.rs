use anchor_lang::prelude::*;

/// Configuração global da plataforma (PDA: ["config"]).
/// Só a upgrade authority do programa pode criá-la (PS-03).
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Quem pode alterar a configuração.
    pub admin: Pubkey,
    /// Árbitro padrão para jobs NOVOS (cada job guarda o seu; PS-04).
    pub arbiter: Pubkey,
    /// Carteira que recebe a taxa da plataforma em jobs NOVOS (cada job guarda a sua; PS-37).
    pub treasury: Pubkey,
    /// Taxa padrão para jobs NOVOS, em basis points sobre o valor pago ao pesquisador.
    pub fee_bps: u16,
    /// Se diferente de Pubkey::default(), só esse mint é aceito (ex.: USDC).
    pub allowed_mint: Pubkey,
    /// Prazo padrão (s) para o árbitro decidir uma disputa em jobs NOVOS.
    pub dispute_period: i64,
    pub bump: u8,
}

/// Escrow de um job de pentest/auditoria.
/// PDA: ["job", client, job_id]
///
/// Todos os campos de tamanho fixo vêm antes de `job_id`, então os offsets são
/// estáveis e servem para filtros `memcmp` (cliente = 8, pesquisador = 40, status = 232).
/// O layout é decodificado fora da chain em `backend-serverless/functions/common/solana.py`.
#[account]
#[derive(InitSpace)]
pub struct JobAccount {
    pub client: Pubkey, // 8
    /// Pubkey::default() = aguardando o cliente atribuir um pesquisador (PS-01).
    pub researcher: Pubkey, // 40
    pub mint: Pubkey,   // 72
    pub vault: Pubkey,  // 104
    /// Valor travado na criação, em unidades base do token (USDC = 6 casas).
    pub amount: u64, // 136
    /// Prazo para entrega da evidência (unix timestamp).
    pub deadline: i64, // 144
    /// Duração da janela de revisão após a evidência (segundos).
    pub review_period: i64, // 152
    /// Fim da janela de revisão (0 até a evidência ser enviada).
    pub review_deadline: i64, // 160
    /// SHA-256 do escopo / Rules of Engagement aprovado pelo cliente.
    pub scope_hash: [u8; 32], // 168
    /// SHA-256 do relatório (blob cifrado guardado no S3).
    pub evidence_sha256: [u8; 32], // 200
    pub status: JobStatus, // 232
    pub created_by_agent: bool, // 233
    pub bump: u8,       // 234
    pub vault_bump: u8, // 235
    /// Árbitro congelado na criação do job (PS-04).
    pub arbiter: Pubkey, // 236
    /// Quem pagou o rent do vault; recebe o rent de volta quando o vault fecha (PS-14).
    pub rent_payer: Pubkey, // 268
    /// Taxa congelada na criação do job (PS-04).
    pub fee_bps: u16, // 300
    /// Prazo do árbitro congelado na criação do job (PS-02 / PS-04).
    pub dispute_period: i64, // 302
    /// Fim do prazo do árbitro (0 até abrir disputa).
    pub dispute_deadline: i64, // 310
    /// Tesouraria congelada na criação do job (PS-37 / ADR-021): a taxa só vai para a ATA dela,
    /// mesmo que o admin troque a tesouraria da `Config` depois.
    pub treasury: Pubkey, // 318
    #[max_len(32)]
    pub job_id: String, // 350 (u32 len + bytes)
}

/// Política de gasto do agente de IA, imposta on-chain.
/// PDA: ["policy", owner]
///
/// O dono também precisa aprovar este PDA como *delegate* na sua conta de
/// USDC (spl-token approve). Assim a chave do agente nunca tem custódia: ela só
/// consegue mover fundos da empresa para escrows, dentro dos limites abaixo.
#[account]
#[derive(InitSpace)]
pub struct AgentPolicy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_per_job: u64,
    pub max_per_period: u64,
    pub period_seconds: i64,
    pub period_start: i64,
    pub spent_in_period: u64,
    pub active: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum JobStatus {
    Open,              // 0 - financiado, aguardando atribuição/aceite
    InProgress,        // 1 - pesquisador atribuído aceitou
    EvidenceSubmitted, // 2 - hash do relatório on-chain, janela de revisão correndo
    Disputed,          // 3 - cliente contestou dentro da janela
    Completed,         // 4 - pago ao pesquisador (aprovação ou fim da janela)
    Resolved,          // 5 - disputa resolvida (árbitro ou prazo esgotado)
    Refunded,          // 6 - prazo expirou sem entrega, devolvido ao cliente
    Cancelled,         // 7 - cancelado pelo cliente antes do aceite
}
