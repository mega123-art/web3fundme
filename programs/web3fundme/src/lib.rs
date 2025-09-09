use anchor_lang::prelude::*;

declare_id!("DAddeAYBo1UdTWov3CjxT2wfKzh6X18bcPYSbNvv7Ga8");



use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};



#[program]
pub mod donation_matching {
    use super::*;

    pub fn initialize_platform(ctx: Context<InitializePlatform>) -> Result<()> {
        let platform = &mut ctx.accounts.platform;
        platform.admin = ctx.accounts.admin.key();
        platform.fee_percentage = 250; // 2.5% platform fee
        platform.total_campaigns = 0;
        platform.total_raised = 0;
        Ok(())
    }

    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        goal_amount: u64,
        matching_pool_amount: u64,
        campaign_duration: i64,
        title: String,
        description: String,
        matching_ratio: u8, // e.g., 100 = 1:1 matching, 50 = 0.5:1 matching
        beneficiary: Pubkey,
    ) -> Result<()> {
        require!(goal_amount > 0, ErrorCode::InvalidGoalAmount);
        require!(matching_pool_amount > 0, ErrorCode::InvalidMatchingAmount);
        require!(matching_ratio > 0 && matching_ratio <= 200, ErrorCode::InvalidMatchingRatio);
        require!(campaign_duration > 0, ErrorCode::InvalidDuration);
        require!(title.len() <= 100, ErrorCode::TitleTooLong);
        require!(description.len() <= 500, ErrorCode::DescriptionTooLong);

        let campaign = &mut ctx.accounts.campaign;
        let platform = &mut ctx.accounts.platform;
        
        campaign.creator = ctx.accounts.creator.key();
        campaign.beneficiary = beneficiary;
        campaign.goal_amount = goal_amount;
        campaign.raised_amount = 0;
        campaign.matching_pool_total = matching_pool_amount;
        campaign.matching_pool_remaining = matching_pool_amount;
        campaign.matching_ratio = matching_ratio;
        campaign.title = title;
        campaign.description = description;
        campaign.created_at = Clock::get()?.unix_timestamp;
        campaign.end_time = Clock::get()?.unix_timestamp.checked_add(campaign_duration)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        campaign.is_active = true;
        campaign.total_donors = 0;
        campaign.campaign_id = platform.total_campaigns;

        platform.total_campaigns = platform.total_campaigns.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Transfer matching pool from creator to campaign vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.campaign_vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, matching_pool_amount)?;

        emit!(CampaignCreated {
            campaign_id: campaign.campaign_id,
            creator: campaign.creator,
            goal_amount,
            matching_pool_amount,
        });

        Ok(())
    }

    pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidDonationAmount);
        
        let campaign = &mut ctx.accounts.campaign;
        let platform = &mut ctx.accounts.platform;
        
        require!(campaign.is_active, ErrorCode::CampaignInactive);
        require!(Clock::get()?.unix_timestamp <= campaign.end_time, ErrorCode::CampaignExpired);
        require!(campaign.raised_amount < campaign.goal_amount, ErrorCode::GoalReached);

        // Calculate matching amount
        let matching_amount = calculate_matching_amount(
            amount,
            campaign.matching_ratio,
            campaign.matching_pool_remaining,
        )?;

        let total_contribution = amount.checked_add(matching_amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        
        // Update donation record
        let donation = &mut ctx.accounts.donation;
        donation.donor = ctx.accounts.donor.key();
        donation.campaign = ctx.accounts.campaign.key();
        donation.amount = amount;
        donation.matching_amount = matching_amount;
        donation.total_amount = total_contribution;
        donation.timestamp = Clock::get()?.unix_timestamp;

        // Update campaign state
        campaign.raised_amount = campaign.raised_amount.checked_add(total_contribution)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        campaign.matching_pool_remaining = campaign.matching_pool_remaining.checked_sub(matching_amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        campaign.total_donors = campaign.total_donors.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Update platform stats
        platform.total_raised = platform.total_raised.checked_add(total_contribution)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Transfer donation from donor to campaign vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.donor_token_account.to_account_info(),
            to: ctx.accounts.campaign_vault.to_account_info(),
            authority: ctx.accounts.donor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(DonationMade {
            campaign_id: campaign.campaign_id,
            donor: ctx.accounts.donor.key(),
            amount,
            matching_amount,
            total_amount: total_contribution,
        });

        // Check if goal reached
        if campaign.raised_amount >= campaign.goal_amount {
            campaign.is_active = false;
            emit!(GoalReached {
                campaign_id: campaign.campaign_id,
                final_amount: campaign.raised_amount,
            });
        }

        Ok(())
    }

    pub fn withdraw_funds(ctx: Context<WithdrawFunds>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        
        require!(
            ctx.accounts.beneficiary.key() == campaign.beneficiary ||
            ctx.accounts.beneficiary.key() == campaign.creator,
            ErrorCode::UnauthorizedWithdrawal
        );
        
        require!(
            !campaign.is_active || 
            Clock::get()?.unix_timestamp > campaign.end_time ||
            campaign.raised_amount >= campaign.goal_amount,
            ErrorCode::CampaignStillActive
        );

        let vault_balance = ctx.accounts.campaign_vault.amount;
        require!(vault_balance > 0, ErrorCode::NoFundsToWithdraw);

        // Calculate platform fee
        let platform_fee = vault_balance.checked_mul(ctx.accounts.platform.fee_percentage as u64)
            .ok_or(ErrorCode::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        let withdrawal_amount = vault_balance.checked_sub(platform_fee)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Create signer seeds for vault authority
        let campaign_key = campaign.key();
        let seeds = &[
            b"vault_auth",
            campaign_key.as_ref(),
            &[ctx.bumps.vault_auth],
        ];
        let signer = &[&seeds[..]];

        // Transfer funds to beneficiary
        let cpi_accounts = Transfer {
            from: ctx.accounts.campaign_vault.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: ctx.accounts.vault_auth.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, withdrawal_amount)?;

        // Transfer platform fee if applicable
        if platform_fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.campaign_vault.to_account_info(),
                to: ctx.accounts.platform_fee_account.to_account_info(),
                authority: ctx.accounts.vault_auth.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, platform_fee)?;
        }

        emit!(FundsWithdrawn {
            campaign_id: campaign.campaign_id,
            beneficiary: ctx.accounts.beneficiary.key(),
            amount: withdrawal_amount,
            platform_fee,
        });

        Ok(())
    }

    pub fn emergency_pause_campaign(ctx: Context<EmergencyPauseCampaign>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.platform.admin,
            ErrorCode::Unauthorized
        );
        
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_active = false;

        emit!(CampaignPaused {
            campaign_id: campaign.campaign_id,
        });

        Ok(())
    }

    pub fn add_matching_funds(ctx: Context<AddMatchingFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.is_active, ErrorCode::CampaignInactive);

        // Transfer additional matching funds
        let cpi_accounts = Transfer {
            from: ctx.accounts.matcher_token_account.to_account_info(),
            to: ctx.accounts.campaign_vault.to_account_info(),
            authority: ctx.accounts.matcher.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        campaign.matching_pool_total = campaign.matching_pool_total.checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        campaign.matching_pool_remaining = campaign.matching_pool_remaining.checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(MatchingFundsAdded {
            campaign_id: campaign.campaign_id,
            matcher: ctx.accounts.matcher.key(),
            amount,
        });

        Ok(())
    }
}

fn calculate_matching_amount(
    donation_amount: u64,
    matching_ratio: u8,
    remaining_pool: u64,
) -> Result<u64> {
    let theoretical_match = donation_amount.checked_mul(matching_ratio as u64)
        .ok_or(ErrorCode::ArithmeticOverflow)?
        .checked_div(100)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    let actual_match = std::cmp::min(theoretical_match, remaining_pool);
    Ok(actual_match)
}

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Platform::INIT_SPACE,
        seeds = [b"platform"],
        bump
    )]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateCampaign<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", &platform.total_campaigns.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init,
        payer = creator,
        token::mint = usdc_mint,
        token::authority = vault_auth,
        seeds = [b"vault", campaign.key().as_ref()],
        bump
    )]
    pub campaign_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for the vault
    #[account(
        seeds = [b"vault_auth", campaign.key().as_ref()],
        bump
    )]
    pub vault_auth: AccountInfo<'info>,
    #[account(mut)]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        constraint = creator_token_account.mint == usdc_mint.key(),
        constraint = creator_token_account.owner == creator.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        constraint = campaign_vault.mint == usdc_mint.key()
    )]
    pub campaign_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = donor,
        space = 8 + Donation::INIT_SPACE,
        seeds = [b"donation", campaign.key().as_ref(), donor.key().as_ref(), &campaign.total_donors.to_le_bytes()],
        bump
    )]
    pub donation: Account<'info, Donation>,
    #[account(mut)]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub donor: Signer<'info>,
    #[account(
        mut,
        constraint = donor_token_account.mint == usdc_mint.key(),
        constraint = donor_token_account.owner == donor.key()
    )]
    pub donor_token_account: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFunds<'info> {
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        constraint = campaign_vault.mint == usdc_mint.key()
    )]
    pub campaign_vault: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for the vault
    #[account(
        seeds = [b"vault_auth", campaign.key().as_ref()],
        bump
    )]
    pub vault_auth: AccountInfo<'info>,
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub beneficiary: Signer<'info>,
    #[account(
        mut,
        constraint = beneficiary_token_account.mint == usdc_mint.key(),
        constraint = beneficiary_token_account.owner == beneficiary.key()
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = platform_fee_account.mint == usdc_mint.key()
    )]
    pub platform_fee_account: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyPauseCampaign<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    pub platform: Account<'info, Platform>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AddMatchingFunds<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        constraint = campaign_vault.mint == usdc_mint.key()
    )]
    pub campaign_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub matcher: Signer<'info>,
    #[account(
        mut,
        constraint = matcher_token_account.mint == usdc_mint.key(),
        constraint = matcher_token_account.owner == matcher.key()
    )]
    pub matcher_token_account: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    pub fee_percentage: u16, // basis points (e.g., 250 = 2.5%)
    pub total_campaigns: u64,
    pub total_raised: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub campaign_id: u64,
    pub creator: Pubkey,
    pub beneficiary: Pubkey,
    pub goal_amount: u64,
    pub raised_amount: u64,
    pub matching_pool_total: u64,
    pub matching_pool_remaining: u64,
    pub matching_ratio: u8, // percentage (e.g., 100 = 1:1 matching)
    #[max_len(100)]
    pub title: String,
    #[max_len(500)]
    pub description: String,
    pub created_at: i64,
    pub end_time: i64,
    pub is_active: bool,
    pub total_donors: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Donation {
    pub donor: Pubkey,
    pub campaign: Pubkey,
    pub amount: u64,
    pub matching_amount: u64,
    pub total_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CampaignCreated {
    pub campaign_id: u64,
    pub creator: Pubkey,
    pub goal_amount: u64,
    pub matching_pool_amount: u64,
}

#[event]
pub struct DonationMade {
    pub campaign_id: u64,
    pub donor: Pubkey,
    pub amount: u64,
    pub matching_amount: u64,
    pub total_amount: u64,
}

#[event]
pub struct GoalReached {
    pub campaign_id: u64,
    pub final_amount: u64,
}

#[event]
pub struct FundsWithdrawn {
    pub campaign_id: u64,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub platform_fee: u64,
}

#[event]
pub struct CampaignPaused {
    pub campaign_id: u64,
}

#[event]
pub struct MatchingFundsAdded {
    pub campaign_id: u64,
    pub matcher: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid goal amount")]
    InvalidGoalAmount,
    #[msg("Invalid matching amount")]
    InvalidMatchingAmount,
    #[msg("Invalid matching ratio")]
    InvalidMatchingRatio,
    #[msg("Invalid duration")]
    InvalidDuration,
    #[msg("Title too long")]
    TitleTooLong,
    #[msg("Description too long")]
    DescriptionTooLong,
    #[msg("Invalid donation amount")]
    InvalidDonationAmount,
    #[msg("Campaign is inactive")]
    CampaignInactive,
    #[msg("Campaign has expired")]
    CampaignExpired,
    #[msg("Goal already reached")]
    GoalReached,
    #[msg("Unauthorized withdrawal")]
    UnauthorizedWithdrawal,
    #[msg("Campaign is still active")]
    CampaignStillActive,
    #[msg("No funds to withdraw")]
    NoFundsToWithdraw,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}