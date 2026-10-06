use anchor_lang::prelude::*;

#[error_code]
pub enum ProofSecError {
    #[msg("Job não está disponível para aceite.")]
    JobNotOpen,
    #[msg("Job não está em andamento.")]
    JobNotInProgress,
    #[msg("Pesquisador não autorizado para este job.")]
    UnauthorizedResearcher,
    #[msg("Evidência técnica ainda não foi submetida.")]
    EvidenceNotSubmitted,
    #[msg("O prazo do contrato ainda não expirou.")]
    DeadlineNotExpired,
    #[msg("O prazo do contrato já expirou.")]
    DeadlineExpired,
    #[msg("Não é possível reembolsar neste estado.")]
    CannotRefund,
    #[msg("A janela de revisão ainda está aberta.")]
    ReviewWindowOpen,
    #[msg("A janela de revisão já terminou.")]
    ReviewWindowClosed,
    #[msg("Job não está em disputa.")]
    NotDisputed,
    #[msg("Valor inválido.")]
    InvalidAmount,
    #[msg("Prazo inválido.")]
    InvalidDeadline,
    #[msg("Janela de revisão inválida.")]
    InvalidReviewPeriod,
    #[msg("job_id inválido (1 a 32 bytes).")]
    InvalidJobId,
    #[msg("Hash inválido (não pode ser zero).")]
    InvalidHash,
    #[msg("Mint não permitido pela configuração.")]
    MintNotAllowed,
    #[msg("Conta de token não pertence à carteira esperada.")]
    InvalidTokenAccount,
    #[msg("Taxa acima do máximo permitido.")]
    FeeTooHigh,
    #[msg("Basis points inválidos.")]
    InvalidBps,
    #[msg("Política do agente está inativa.")]
    PolicyInactive,
    #[msg("Valor excede o limite por job da política do agente.")]
    ExceedsPerJobLimit,
    #[msg("Valor excede o limite do período da política do agente.")]
    ExceedsPeriodLimit,
    #[msg("Parâmetros de política inválidos.")]
    InvalidPolicy,
    #[msg("Overflow aritmético.")]
    MathOverflow,
    #[msg("Nenhum pesquisador atribuído: o cliente precisa atribuir antes do aceite.")]
    ResearcherNotAssigned,
    #[msg("O cliente não pode ser o pesquisador do próprio job.")]
    InvalidResearcher,
    #[msg("Prazo de disputa inválido.")]
    InvalidDisputePeriod,
    #[msg("O prazo do árbitro ainda não terminou.")]
    DisputeWindowOpen,
    #[msg("Autoridade inválida (chave vazia).")]
    InvalidAuthority,
    #[msg("Este estado não permite a recuperação de último recurso.")]
    CannotRecover,
    #[msg("A carência da recuperação de último recurso ainda não terminou.")]
    RecoveryGraceNotElapsed,
}
