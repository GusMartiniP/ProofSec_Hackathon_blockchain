use anchor_lang::prelude::*;

#[error_code]
pub enum ProofSecError {
    #[msg("Job is not available to accept.")]
    JobNotOpen,
    #[msg("Job is not in progress.")]
    JobNotInProgress,
    #[msg("Researcher is not authorized for this job.")]
    UnauthorizedResearcher,
    #[msg("Evidence has not been submitted yet.")]
    EvidenceNotSubmitted,
    #[msg("The job deadline has not passed yet.")]
    DeadlineNotExpired,
    #[msg("The job deadline has already passed.")]
    DeadlineExpired,
    #[msg("Cannot refund in this state.")]
    CannotRefund,
    #[msg("The review window is still open.")]
    ReviewWindowOpen,
    #[msg("The review window has already ended.")]
    ReviewWindowClosed,
    #[msg("Job is not in dispute.")]
    NotDisputed,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Invalid deadline.")]
    InvalidDeadline,
    #[msg("Invalid review period.")]
    InvalidReviewPeriod,
    #[msg("Invalid job_id (1 to 32 bytes).")]
    InvalidJobId,
    #[msg("Invalid hash (cannot be zero).")]
    InvalidHash,
    #[msg("Mint is not allowed by the config.")]
    MintNotAllowed,
    #[msg("Token account does not belong to the expected wallet.")]
    InvalidTokenAccount,
    #[msg("Fee above the maximum allowed.")]
    FeeTooHigh,
    #[msg("Invalid basis points.")]
    InvalidBps,
    #[msg("Agent policy is inactive.")]
    PolicyInactive,
    #[msg("Amount exceeds the agent policy's per-job limit.")]
    ExceedsPerJobLimit,
    #[msg("Amount exceeds the agent policy's period limit.")]
    ExceedsPeriodLimit,
    #[msg("Invalid policy parameters.")]
    InvalidPolicy,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("No researcher assigned: the client must assign one before acceptance.")]
    ResearcherNotAssigned,
    #[msg("The client cannot be the researcher of their own job.")]
    InvalidResearcher,
    #[msg("Invalid dispute period.")]
    InvalidDisputePeriod,
    #[msg("The arbiter's deadline has not passed yet.")]
    DisputeWindowOpen,
    #[msg("Invalid authority (empty key).")]
    InvalidAuthority,
    #[msg("This state does not allow last-resort recovery.")]
    CannotRecover,
    #[msg("The last-resort recovery grace period has not passed yet.")]
    RecoveryGraceNotElapsed,
    #[msg("The job's arbiter cannot be its client or its researcher.")]
    ArbiterConflict,
}
