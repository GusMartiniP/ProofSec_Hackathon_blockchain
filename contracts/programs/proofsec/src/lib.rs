//! ProofSec — Escrow programável para contratações de segurança ofensiva.
//!
//! Fluxo:
//!   initialize_job / initialize_job_by_agent  → USDC travado no vault PDA + scope_hash (RoE)
//!   assign_researcher                         → o cliente escolhe quem pode aceitar (obrigatório)
//!   accept_job                                → só o pesquisador atribuído
//!   submit_evidence                           → SHA-256 do relatório on-chain, abre janela de revisão
//!   approve_and_release                       → cliente aprova (pagamento imediato)
//!   claim_after_review                        → cliente não respondeu na janela → pesquisador saca
//!   open_dispute / resolve_dispute            → cliente contesta → árbitro decide o split
//!   resolve_dispute_timeout                   → árbitro não decidiu no prazo → 50/50 (qualquer um chama)
//!   refund_expired / cancel_job               → devolução ao cliente
//!   recover_stuck_funds                       → último recurso: contas de token travadas, após longa carência
//!
//! Política do agente de IA (set_agent_policy + spl-token approve): o agente só consegue
//! abrir escrows em nome da empresa dentro de limites por job e por período, impostos aqui.
//!
//! Contas de token de destino (ATAs) precisam existir antes da liquidação; os clientes
//! criam com `createAssociatedTokenAccountIdempotent` na mesma transação.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;

use constants::*;
use errors::ProofSecError;
use events::*;
use state::*;

declare_id!("PrfSec1111111111111111111111111111111111111");

#[program]
pub mod proofsec {
    use super::*;

    // ------------------------------------------------------------------
    // Configuração da plataforma
    // ------------------------------------------------------------------

    /// Cria a configuração. Só a upgrade authority do programa pode chamar (PS-03).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        arbiter: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        allowed_mint: Pubkey,
        dispute_period: i64,
    ) -> Result<()> {
        validate_config(arbiter, treasury, fee_bps, dispute_period)?;
        let admin = ctx.accounts.admin.key();
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.arbiter = arbiter;
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.allowed_mint = allowed_mint;
        config.dispute_period = dispute_period;
        config.bump = ctx.bumps.config;

        emit!(ConfigUpdated {
            admin,
            arbiter,
            treasury,
            fee_bps,
            allowed_mint,
            dispute_period,
        });
        Ok(())
    }

    /// Atualiza a configuração. Vale só para jobs NOVOS: taxa, árbitro e prazo de
    /// disputa ficam congelados em cada job (PS-04).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Pubkey,
        arbiter: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        allowed_mint: Pubkey,
        dispute_period: i64,
    ) -> Result<()> {
        require_keys_neq!(
            new_admin,
            Pubkey::default(),
            ProofSecError::InvalidAuthority
        );
        validate_config(arbiter, treasury, fee_bps, dispute_period)?;
        let config = &mut ctx.accounts.config;
        config.admin = new_admin;
        config.arbiter = arbiter;
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.allowed_mint = allowed_mint;
        config.dispute_period = dispute_period;

        emit!(ConfigUpdated {
            admin: new_admin,
            arbiter,
            treasury,
            fee_bps,
            allowed_mint,
            dispute_period,
        });
        Ok(())
    }

    // ------------------------------------------------------------------
    // Política de gasto do agente
    // ------------------------------------------------------------------

    pub fn set_agent_policy(
        ctx: Context<SetAgentPolicy>,
        agent: Pubkey,
        max_per_job: u64,
        max_per_period: u64,
        period_seconds: i64,
        active: bool,
    ) -> Result<()> {
        require!(
            max_per_job > 0 && max_per_period >= max_per_job && period_seconds > 0,
            ProofSecError::InvalidPolicy
        );
        require_keys_neq!(agent, Pubkey::default(), ProofSecError::InvalidPolicy);
        let owner = ctx.accounts.owner.key();
        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.policy;

        if policy.owner == Pubkey::default() {
            // Primeira criação
            policy.owner = owner;
            policy.bump = ctx.bumps.policy;
            policy.period_start = now;
            policy.spent_in_period = 0;
        }
        require_keys_eq!(policy.owner, owner, ProofSecError::InvalidPolicy);

        policy.agent = agent;
        policy.max_per_job = max_per_job;
        policy.max_per_period = max_per_period;
        policy.period_seconds = period_seconds;
        policy.active = active;

        emit!(AgentPolicyUpdated {
            policy: policy.key(),
            owner,
            agent,
            max_per_job,
            max_per_period,
            period_seconds,
            active,
        });
        Ok(())
    }

    // ------------------------------------------------------------------
    // Criação do escrow
    // ------------------------------------------------------------------

    /// Cliente (humano, via carteira) cria o job e trava os fundos.
    /// `researcher` pode vir preenchido (atribuição imediata) ou vazio (Pubkey::default()).
    pub fn initialize_job(
        ctx: Context<InitializeJob>,
        job_id: String,
        amount: u64,
        deadline: i64,
        review_period: i64,
        scope_hash: [u8; 32],
        researcher: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let client = ctx.accounts.client.key();
        validate_new_job(
            &ctx.accounts.config,
            ctx.accounts.mint.key(),
            &job_id,
            amount,
            deadline,
            review_period,
            MIN_REVIEW_PERIOD,
            &scope_hash,
            now,
        )?;
        require_keys_neq!(researcher, client, ProofSecError::InvalidResearcher);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.client_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let terms = Terms::from_config(&ctx.accounts.config);
        let mint = ctx.accounts.mint.key();
        let vault = ctx.accounts.vault.key();
        let job_key = ctx.accounts.job_account.key();
        write_job(
            &mut ctx.accounts.job_account,
            NewJob {
                client,
                researcher,
                mint,
                vault,
                job_id,
                amount,
                deadline,
                review_period,
                scope_hash,
                created_by_agent: false,
                bump: ctx.bumps.job_account,
                vault_bump: ctx.bumps.vault,
                rent_payer: client,
                terms,
            },
        );

        emit!(JobCreated {
            job: job_key,
            client,
            researcher,
            mint,
            amount,
            deadline,
            scope_hash,
            arbiter: terms.arbiter,
            fee_bps: terms.fee_bps,
            created_by_agent: false,
        });
        Ok(())
    }

    /// Agente de IA cria o job em nome da empresa, dentro da política on-chain.
    /// Os fundos saem da conta da empresa usando o PDA da política como delegate.
    /// O agente NÃO escolhe pesquisador e a janela de revisão mínima é maior (PS-05).
    pub fn initialize_job_by_agent(
        ctx: Context<InitializeJobByAgent>,
        job_id: String,
        amount: u64,
        deadline: i64,
        review_period: i64,
        scope_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_new_job(
            &ctx.accounts.config,
            ctx.accounts.mint.key(),
            &job_id,
            amount,
            deadline,
            review_period,
            MIN_AGENT_REVIEW_PERIOD,
            &scope_hash,
            now,
        )?;

        // --- Guardrail de gasto (imposto on-chain, independente da LLM/backend) ---
        let policy_bump;
        {
            let policy = &mut ctx.accounts.policy;
            require!(policy.active, ProofSecError::PolicyInactive);
            require!(
                amount <= policy.max_per_job,
                ProofSecError::ExceedsPerJobLimit
            );

            let period_end = policy
                .period_start
                .checked_add(policy.period_seconds)
                .ok_or(ProofSecError::MathOverflow)?;
            if now >= period_end {
                policy.period_start = now;
                policy.spent_in_period = 0;
            }
            let new_spent = policy
                .spent_in_period
                .checked_add(amount)
                .ok_or(ProofSecError::MathOverflow)?;
            require!(
                new_spent <= policy.max_per_period,
                ProofSecError::ExceedsPeriodLimit
            );
            policy.spent_in_period = new_spent;
            policy_bump = policy.bump;
        }

        let owner = ctx.accounts.owner.key();
        let agent = ctx.accounts.agent.key();
        let policy_bump_seed = [policy_bump];
        let policy_seeds: &[&[u8]] = &[POLICY_SEED, owner.as_ref(), &policy_bump_seed];
        let signer: &[&[&[u8]]] = &[policy_seeds];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let terms = Terms::from_config(&ctx.accounts.config);
        let mint = ctx.accounts.mint.key();
        let vault = ctx.accounts.vault.key();
        let job_key = ctx.accounts.job_account.key();
        write_job(
            &mut ctx.accounts.job_account,
            NewJob {
                client: owner,
                researcher: Pubkey::default(),
                mint,
                vault,
                job_id,
                amount,
                deadline,
                review_period,
                scope_hash,
                created_by_agent: true,
                bump: ctx.bumps.job_account,
                vault_bump: ctx.bumps.vault,
                rent_payer: agent,
                terms,
            },
        );

        emit!(JobCreated {
            job: job_key,
            client: owner,
            researcher: Pubkey::default(),
            mint,
            amount,
            deadline,
            scope_hash,
            arbiter: terms.arbiter,
            fee_bps: terms.fee_bps,
            created_by_agent: true,
        });
        Ok(())
    }

    // ------------------------------------------------------------------
    // Execução
    // ------------------------------------------------------------------

    /// Cliente atribui (ou troca, ou remove) o pesquisador antes do aceite.
    pub fn assign_researcher(ctx: Context<AssignResearcher>, researcher: Pubkey) -> Result<()> {
        let job = &mut ctx.accounts.job_account;
        require!(job.status == JobStatus::Open, ProofSecError::JobNotOpen);
        require_keys_neq!(researcher, job.client, ProofSecError::InvalidResearcher);
        job.researcher = researcher;
        emit!(ResearcherAssigned {
            job: job.key(),
            researcher
        });
        Ok(())
    }

    /// Só o pesquisador atribuído pelo cliente pode aceitar (PS-01).
    pub fn accept_job(ctx: Context<AcceptJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let researcher = ctx.accounts.researcher.key();
        let job = &mut ctx.accounts.job_account;

        require!(job.status == JobStatus::Open, ProofSecError::JobNotOpen);
        require!(now < job.deadline, ProofSecError::DeadlineExpired);
        require_keys_neq!(
            job.researcher,
            Pubkey::default(),
            ProofSecError::ResearcherNotAssigned
        );
        require_keys_eq!(
            job.researcher,
            researcher,
            ProofSecError::UnauthorizedResearcher
        );

        job.status = JobStatus::InProgress;
        emit!(JobAccepted {
            job: job.key(),
            researcher
        });
        Ok(())
    }

    pub fn submit_evidence(ctx: Context<SubmitEvidence>, evidence_sha256: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let researcher = ctx.accounts.researcher.key();
        let job = &mut ctx.accounts.job_account;

        require!(
            job.status == JobStatus::InProgress,
            ProofSecError::JobNotInProgress
        );
        require_keys_eq!(
            job.researcher,
            researcher,
            ProofSecError::UnauthorizedResearcher
        );
        require!(now <= job.deadline, ProofSecError::DeadlineExpired);
        require!(evidence_sha256 != [0u8; 32], ProofSecError::InvalidHash);

        job.evidence_sha256 = evidence_sha256;
        job.review_deadline = now
            .checked_add(job.review_period)
            .ok_or(ProofSecError::MathOverflow)?;
        job.status = JobStatus::EvidenceSubmitted;

        emit!(EvidenceSubmitted {
            job: job.key(),
            researcher,
            evidence_sha256,
            review_deadline: job.review_deadline,
        });
        Ok(())
    }

    // ------------------------------------------------------------------
    // Liquidação
    // ------------------------------------------------------------------

    /// Cliente aprova a evidência: pesquisador recebe (menos a taxa congelada no job).
    pub fn approve_and_release(ctx: Context<ApproveAndRelease>) -> Result<()> {
        require!(
            ctx.accounts.job_account.status == JobStatus::EvidenceSubmitted,
            ProofSecError::EvidenceNotSubmitted
        );
        release_to_researcher(
            &mut ctx.accounts.job_account,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.researcher_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            false,
        )
    }

    /// Janela de revisão terminou sem aprovação nem disputa: pesquisador saca.
    pub fn claim_after_review(ctx: Context<ClaimAfterReview>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.job_account.status == JobStatus::EvidenceSubmitted,
            ProofSecError::EvidenceNotSubmitted
        );
        require!(
            now > ctx.accounts.job_account.review_deadline,
            ProofSecError::ReviewWindowOpen
        );
        release_to_researcher(
            &mut ctx.accounts.job_account,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.researcher_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            true,
        )
    }

    /// Cliente contesta a evidência dentro da janela de revisão. Abre o prazo do árbitro.
    pub fn open_dispute(ctx: Context<OpenDispute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job_account;
        require!(
            job.status == JobStatus::EvidenceSubmitted,
            ProofSecError::EvidenceNotSubmitted
        );
        require!(
            now <= job.review_deadline,
            ProofSecError::ReviewWindowClosed
        );
        job.dispute_deadline = now
            .checked_add(job.dispute_period)
            .ok_or(ProofSecError::MathOverflow)?;
        job.status = JobStatus::Disputed;
        emit!(DisputeOpened {
            job: job.key(),
            client: job.client,
            dispute_deadline: job.dispute_deadline,
        });
        Ok(())
    }

    /// Árbitro congelado no job decide quanto (em bps) vai para o pesquisador;
    /// o resto volta ao cliente.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, researcher_bps: u16) -> Result<()> {
        require!(
            ctx.accounts.job_account.status == JobStatus::Disputed,
            ProofSecError::NotDisputed
        );
        require!(
            (researcher_bps as u64) <= BPS_DENOMINATOR,
            ProofSecError::InvalidBps
        );
        settle_dispute(
            &mut ctx.accounts.job_account,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.researcher_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            ctx.accounts.client_token_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            researcher_bps as u64,
            false,
        )
    }

    /// O árbitro não decidiu dentro do prazo: qualquer pessoa aplica a divisão padrão
    /// (50/50). Garante que os fundos nunca fiquem presos em disputa (PS-02 / INV-4).
    pub fn resolve_dispute_timeout(ctx: Context<ResolveDisputeTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.job_account.status == JobStatus::Disputed,
            ProofSecError::NotDisputed
        );
        require!(
            now > ctx.accounts.job_account.dispute_deadline,
            ProofSecError::DisputeWindowOpen
        );
        settle_dispute(
            &mut ctx.accounts.job_account,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            ctx.accounts.researcher_token_account.to_account_info(),
            ctx.accounts.treasury_token_account.to_account_info(),
            ctx.accounts.client_token_account.to_account_info(),
            ctx.accounts.rent_payer.to_account_info(),
            DISPUTE_TIMEOUT_RESEARCHER_BPS,
            true,
        )
    }

    /// Prazo expirou sem evidência: devolve tudo ao cliente.
    pub fn refund_expired(ctx: Context<RefundJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let status = ctx.accounts.job_account.status;
        require!(
            status == JobStatus::Open || status == JobStatus::InProgress,
            ProofSecError::CannotRefund
        );
        require!(
            now > ctx.accounts.job_account.deadline,
            ProofSecError::DeadlineNotExpired
        );
        refund(ctx, JobStatus::Refunded, false)
    }

    /// Cliente cancela antes de o pesquisador aceitar.
    pub fn cancel_job(ctx: Context<RefundJob>) -> Result<()> {
        require!(
            ctx.accounts.job_account.status == JobStatus::Open,
            ProofSecError::CannotRefund
        );
        refund(ctx, JobStatus::Cancelled, true)
    }

    /// Último recurso (PS-37 / INV-4): se as contas de token de uma liquidação ficarem inutilizáveis
    /// (por exemplo, ATA congelada pelo emissor do mint) e ninguém liquidar, depois de
    /// `RECOVERY_GRACE_PERIOD` qualquer pessoa devolve o saldo inteiro ao cliente. O destino é fixo
    /// (a ATA do cliente do job), então quem chama não ganha nada além de destravar.
    pub fn recover_stuck_funds(ctx: Context<RecoverStuckFunds>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &ctx.accounts.job_account;
        let (reference, from_dispute) = match job.status {
            JobStatus::EvidenceSubmitted => (job.review_deadline, false),
            JobStatus::Disputed => (job.dispute_deadline, true),
            _ => return err!(ProofSecError::CannotRecover),
        };
        let unlock_at = reference
            .checked_add(RECOVERY_GRACE_PERIOD)
            .ok_or(ProofSecError::MathOverflow)?;
        require!(now > unlock_at, ProofSecError::RecoveryGraceNotElapsed);
        recover(ctx, from_dispute)
    }
}

// ==========================================================================
// Helpers
// ==========================================================================

/// Termos congelados no job a partir da configuração vigente (PS-04).
#[derive(Clone, Copy)]
struct Terms {
    arbiter: Pubkey,
    treasury: Pubkey,
    fee_bps: u16,
    dispute_period: i64,
}

impl Terms {
    fn from_config(config: &Config) -> Self {
        Terms {
            arbiter: config.arbiter,
            treasury: config.treasury,
            fee_bps: config.fee_bps,
            dispute_period: config.dispute_period,
        }
    }
}

struct NewJob {
    client: Pubkey,
    researcher: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    job_id: String,
    amount: u64,
    deadline: i64,
    review_period: i64,
    scope_hash: [u8; 32],
    created_by_agent: bool,
    bump: u8,
    vault_bump: u8,
    rent_payer: Pubkey,
    terms: Terms,
}

fn validate_config(
    arbiter: Pubkey,
    treasury: Pubkey,
    fee_bps: u16,
    dispute_period: i64,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ProofSecError::FeeTooHigh);
    require_keys_neq!(arbiter, Pubkey::default(), ProofSecError::InvalidAuthority);
    require_keys_neq!(treasury, Pubkey::default(), ProofSecError::InvalidAuthority);
    require!(
        (MIN_DISPUTE_PERIOD..=MAX_DISPUTE_PERIOD).contains(&dispute_period),
        ProofSecError::InvalidDisputePeriod
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_new_job(
    config: &Config,
    mint: Pubkey,
    job_id: &str,
    amount: u64,
    deadline: i64,
    review_period: i64,
    min_review_period: i64,
    scope_hash: &[u8; 32],
    now: i64,
) -> Result<()> {
    require!(
        !job_id.is_empty() && job_id.len() <= MAX_JOB_ID_LEN,
        ProofSecError::InvalidJobId
    );
    require!(amount > 0, ProofSecError::InvalidAmount);
    let min_deadline = now
        .checked_add(MIN_JOB_DURATION)
        .ok_or(ProofSecError::MathOverflow)?;
    let max_deadline = now
        .checked_add(MAX_JOB_DURATION)
        .ok_or(ProofSecError::MathOverflow)?;
    require!(
        deadline >= min_deadline && deadline <= max_deadline,
        ProofSecError::InvalidDeadline
    );
    require!(
        (min_review_period..=MAX_REVIEW_PERIOD).contains(&review_period),
        ProofSecError::InvalidReviewPeriod
    );
    require!(*scope_hash != [0u8; 32], ProofSecError::InvalidHash);
    if config.allowed_mint != Pubkey::default() {
        require_keys_eq!(mint, config.allowed_mint, ProofSecError::MintNotAllowed);
    }
    Ok(())
}

fn write_job(job: &mut JobAccount, n: NewJob) {
    job.client = n.client;
    job.researcher = n.researcher;
    job.mint = n.mint;
    job.vault = n.vault;
    job.amount = n.amount;
    job.deadline = n.deadline;
    job.review_period = n.review_period;
    job.review_deadline = 0;
    job.scope_hash = n.scope_hash;
    job.evidence_sha256 = [0u8; 32];
    job.status = JobStatus::Open;
    job.created_by_agent = n.created_by_agent;
    job.bump = n.bump;
    job.vault_bump = n.vault_bump;
    job.arbiter = n.terms.arbiter;
    job.treasury = n.terms.treasury;
    job.rent_payer = n.rent_payer;
    job.fee_bps = n.terms.fee_bps;
    job.dispute_period = n.terms.dispute_period;
    job.dispute_deadline = 0;
    job.job_id = n.job_id;
}

/// O vault é uma token account cuja autoridade é o PDA do job;
/// estas são as partes das seeds usadas para assinar por ele.
fn job_seed_parts(job: &JobAccount) -> (Pubkey, String, u8) {
    (job.client, job.job_id.clone(), job.bump)
}

fn mul_bps(amount: u64, bps: u64) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(ProofSecError::MathOverflow)?
        / (BPS_DENOMINATOR as u128);
    u64::try_from(v).map_err(|_| error!(ProofSecError::MathOverflow))
}

fn vault_transfer<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    to: AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )
}

fn close_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    destination: AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination,
            authority: authority.clone(),
        },
        signer,
    ))
}

/// Distribui o saldo do vault e fecha a conta (rent volta para `rent_destination`).
/// Usa o saldo real do vault (não `job.amount`), então tokens enviados por
/// terceiros ao vault não conseguem travar o fechamento.
/// Retorna (valor líquido ao pesquisador, taxa, valor devolvido ao cliente).
#[allow(clippy::too_many_arguments)]
fn settle<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    researcher_ata: AccountInfo<'info>,
    treasury_ata: AccountInfo<'info>,
    client_ata: Option<AccountInfo<'info>>,
    rent_destination: AccountInfo<'info>,
    total: u64,
    researcher_gross: u64,
    fee_bps: u16,
    signer: &[&[&[u8]]],
) -> Result<(u64, u64, u64)> {
    require!(researcher_gross <= total, ProofSecError::MathOverflow);
    let fee = mul_bps(researcher_gross, fee_bps as u64)?;
    let researcher_net = researcher_gross - fee;
    let client_amount = total - researcher_gross;

    vault_transfer(
        token_program,
        vault,
        authority,
        mint,
        researcher_ata,
        researcher_net,
        signer,
    )?;
    vault_transfer(
        token_program,
        vault,
        authority,
        mint,
        treasury_ata,
        fee,
        signer,
    )?;
    if client_amount > 0 {
        let client_ata = client_ata.ok_or(ProofSecError::InvalidTokenAccount)?;
        vault_transfer(
            token_program,
            vault,
            authority,
            mint,
            client_ata,
            client_amount,
            signer,
        )?;
    }
    close_vault(token_program, vault, authority, rent_destination, signer)?;
    Ok((researcher_net, fee, client_amount))
}

/// Pagamento integral ao pesquisador (aprovação ou fim da janela de revisão).
#[allow(clippy::too_many_arguments)]
fn release_to_researcher<'info>(
    job: &mut Account<'info, JobAccount>,
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    researcher_ata: AccountInfo<'info>,
    treasury_ata: AccountInfo<'info>,
    rent_destination: AccountInfo<'info>,
    auto_released: bool,
) -> Result<()> {
    let (client_key, job_id, job_bump) = job_seed_parts(job);
    let bump = [job_bump];
    let seeds: &[&[u8]] = &[JOB_SEED, client_key.as_ref(), job_id.as_bytes(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let authority = job.to_account_info();

    let total = vault.amount;
    let (researcher_amount, fee, _) = settle(
        token_program,
        vault,
        &authority,
        mint,
        researcher_ata,
        treasury_ata,
        None,
        rent_destination,
        total,
        total,
        job.fee_bps,
        signer,
    )?;

    job.status = JobStatus::Completed;
    emit!(JobReleased {
        job: job.key(),
        researcher: job.researcher,
        researcher_amount,
        fee,
        auto_released,
    });
    Ok(())
}

/// Divide o vault entre pesquisador e cliente (árbitro ou prazo esgotado).
#[allow(clippy::too_many_arguments)]
fn settle_dispute<'info>(
    job: &mut Account<'info, JobAccount>,
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    researcher_ata: AccountInfo<'info>,
    treasury_ata: AccountInfo<'info>,
    client_ata: AccountInfo<'info>,
    rent_destination: AccountInfo<'info>,
    researcher_bps: u64,
    timed_out: bool,
) -> Result<()> {
    let (client_key, job_id, job_bump) = job_seed_parts(job);
    let bump = [job_bump];
    let seeds: &[&[u8]] = &[JOB_SEED, client_key.as_ref(), job_id.as_bytes(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let authority = job.to_account_info();

    let total = vault.amount;
    let researcher_gross = mul_bps(total, researcher_bps)?;
    let (researcher_amount, fee, client_amount) = settle(
        token_program,
        vault,
        &authority,
        mint,
        researcher_ata,
        treasury_ata,
        Some(client_ata),
        rent_destination,
        total,
        researcher_gross,
        job.fee_bps,
        signer,
    )?;

    job.status = JobStatus::Resolved;
    emit!(DisputeResolved {
        job: job.key(),
        researcher_bps: researcher_bps as u16,
        researcher_amount,
        client_amount,
        fee,
        timed_out,
    });
    Ok(())
}

fn refund(ctx: Context<RefundJob>, final_status: JobStatus, cancelled: bool) -> Result<()> {
    let (client_key, job_id, job_bump) = job_seed_parts(&ctx.accounts.job_account);
    let bump = [job_bump];
    let seeds: &[&[u8]] = &[JOB_SEED, client_key.as_ref(), job_id.as_bytes(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let authority = ctx.accounts.job_account.to_account_info();

    let total = ctx.accounts.vault.amount;
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &authority,
        &ctx.accounts.mint,
        ctx.accounts.client_token_account.to_account_info(),
        total,
        signer,
    )?;
    close_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &authority,
        ctx.accounts.rent_payer.to_account_info(),
        signer,
    )?;

    let job = &mut ctx.accounts.job_account;
    job.status = final_status;
    emit!(JobRefunded {
        job: job.key(),
        client: job.client,
        amount: total,
        cancelled,
    });
    Ok(())
}

/// Devolve o saldo do vault ao cliente e fecha o vault (usado só por `recover_stuck_funds`).
fn recover(ctx: Context<RecoverStuckFunds>, from_dispute: bool) -> Result<()> {
    let (client_key, job_id, job_bump) = job_seed_parts(&ctx.accounts.job_account);
    let bump = [job_bump];
    let seeds: &[&[u8]] = &[JOB_SEED, client_key.as_ref(), job_id.as_bytes(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];
    let authority = ctx.accounts.job_account.to_account_info();

    let total = ctx.accounts.vault.amount;
    vault_transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &authority,
        &ctx.accounts.mint,
        ctx.accounts.client_token_account.to_account_info(),
        total,
        signer,
    )?;
    close_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &authority,
        ctx.accounts.rent_payer.to_account_info(),
        signer,
    )?;

    let job = &mut ctx.accounts.job_account;
    job.status = JobStatus::Refunded;
    emit!(JobRecovered {
        job: job.key(),
        client: job.client,
        amount: total,
        from_dispute,
    });
    Ok(())
}

// ==========================================================================
// Contas
// (a ordem dos campos define a ordem das contas na instrução / no IDL)
// ==========================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// O próprio programa, para localizar a conta ProgramData.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ ProofSecError::InvalidAuthority
    )]
    pub program: Program<'info, crate::program::Proofsec>,
    /// Só a upgrade authority pode criar a configuração (PS-03).
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ ProofSecError::InvalidAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAgentPolicy<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + AgentPolicy::INIT_SPACE,
        seeds = [POLICY_SEED, owner.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, AgentPolicy>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: String)]
pub struct InitializeJob<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = client,
        space = 8 + JobAccount::INIT_SPACE,
        seeds = [JOB_SEED, client.key().as_ref(), job_id.as_bytes()],
        bump
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(
        init,
        payer = client,
        seeds = [VAULT_SEED, client.key().as_ref(), job_id.as_bytes()],
        bump,
        token::mint = mint,
        token::authority = job_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        constraint = client_token_account.owner == client.key() @ ProofSecError::InvalidTokenAccount,
        constraint = client_token_account.mint == mint.key() @ ProofSecError::InvalidTokenAccount,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: String)]
pub struct InitializeJobByAgent<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = agent, has_one = owner)]
    pub policy: Account<'info, AgentPolicy>,
    #[account(mut)]
    pub agent: Signer<'info>,
    /// CHECK: validado por `has_one = owner` na política.
    pub owner: UncheckedAccount<'info>,
    #[account(
        init,
        payer = agent,
        space = 8 + JobAccount::INIT_SPACE,
        seeds = [JOB_SEED, owner.key().as_ref(), job_id.as_bytes()],
        bump
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(
        init,
        payer = agent,
        seeds = [VAULT_SEED, owner.key().as_ref(), job_id.as_bytes()],
        bump,
        token::mint = mint,
        token::authority = job_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Conta de USDC da empresa; o PDA `policy` precisa ser o delegate dela
    /// (o Token Program rejeita a transferência caso contrário).
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key() @ ProofSecError::InvalidTokenAccount,
        constraint = owner_token_account.mint == mint.key() @ ProofSecError::InvalidTokenAccount,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AssignResearcher<'info> {
    #[account(mut, has_one = client)]
    pub job_account: Account<'info, JobAccount>,
    pub client: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptJob<'info> {
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    pub researcher: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitEvidence<'info> {
    #[account(mut)]
    pub job_account: Account<'info, JobAccount>,
    pub researcher: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveAndRelease<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = client,
        has_one = vault,
        has_one = mint,
        has_one = researcher,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub client: Signer<'info>,
    /// CHECK: validado por `has_one = researcher` no job.
    pub researcher: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = researcher,
    )]
    pub researcher_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado contra a tesouraria congelada no job (PS-37), não a da `Config` atual.
    #[account(address = job_account.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// `dup`: pode coincidir com a ATA do pesquisador (ex.: admin testando como pesquisador).
    #[account(
        mut,
        dup,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimAfterReview<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = vault,
        has_one = mint,
        has_one = researcher,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub researcher: Signer<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = researcher,
    )]
    pub researcher_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado contra a tesouraria congelada no job (PS-37), não a da `Config` atual.
    #[account(address = job_account.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        mut,
        dup,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(mut, has_one = client)]
    pub job_account: Account<'info, JobAccount>,
    pub client: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Árbitro congelado no job (PS-04), não o da configuração atual.
    pub arbiter: Signer<'info>,
    #[account(
        mut,
        has_one = arbiter,
        has_one = client,
        has_one = vault,
        has_one = mint,
        has_one = researcher,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: validado por `has_one = client`.
    pub client: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = researcher`.
    pub researcher: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = researcher,
    )]
    pub researcher_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado contra a tesouraria congelada no job (PS-37), não a da `Config` atual.
    #[account(address = job_account.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// `dup`: pode coincidir com a ATA do cliente ou do pesquisador.
    #[account(
        mut,
        dup,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Sem signer de instrução: qualquer pessoa pode encerrar uma disputa vencida.
/// Os destinos são fixos (ATAs do job), então quem chama não ganha nada além de destravar.
#[derive(Accounts)]
pub struct ResolveDisputeTimeout<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = client,
        has_one = vault,
        has_one = mint,
        has_one = researcher,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: validado por `has_one = client`.
    pub client: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = researcher`.
    pub researcher: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = researcher,
    )]
    pub researcher_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado contra a tesouraria congelada no job (PS-37), não a da `Config` atual.
    #[account(address = job_account.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        mut,
        dup,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundJob<'info> {
    #[account(
        mut,
        has_one = client,
        has_one = vault,
        has_one = mint,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub client: Signer<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Sem signer de instrução: qualquer pessoa pode acionar a recuperação depois da carência.
/// O destino é a ATA do cliente do job, fixo (INV-5).
#[derive(Accounts)]
pub struct RecoverStuckFunds<'info> {
    #[account(
        mut,
        has_one = client,
        has_one = vault,
        has_one = mint,
        has_one = rent_payer
    )]
    pub job_account: Account<'info, JobAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: validado por `has_one = client`.
    pub client: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = client,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    /// CHECK: validado por `has_one = rent_payer`; recebe o rent do vault.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
