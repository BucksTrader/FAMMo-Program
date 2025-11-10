use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token::{Token, Mint};
use anchor_spl::associated_token::AssociatedToken;
use mpl_token_metadata::{
    ID as TOKEN_METADATA_PROGRAM_ID,
    accounts::{Metadata, MasterEdition},
    types::{Creator, DataV2, Collection},
};

declare_id!("C4FiFWofsjxRGXrcF5i1RnxPHc7QDcSf9XzhFgLQyioh");

#[program]
pub mod nft_minter {
    use super::*;

    /// Initialize the minting program with the master edition
    pub fn initialize(ctx: Context<Initialize>, master_mint: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.master_mint = master_mint;
        config.mint_price = 200_000_000; // 0.2 SOL in lamports
        config.discounted_price = 100_000_000; // 0.1 SOL in lamports (for dapp mints)
        config.total_minted = 0;
        config.payment_vault = ctx.accounts.payment_vault.key();
        
        msg!("NFT Minter initialized!");
        msg!("Master Mint: {}", master_mint);
        msg!("Regular Mint Price: {} lamports (0.2 SOL)", config.mint_price);
        msg!("Discounted Price: {} lamports (0.1 SOL)", config.discounted_price);
        
        Ok(())
    }

    /// Mint a new edition NFT to a user (regular price - for website)
    pub fn mint_edition(ctx: Context<MintEdition>) -> Result<()> {
        mint_nft_internal(ctx, false)
    }

    /// Mint a new edition NFT to a user (discounted price - for dapp)
    pub fn mint_discounted(ctx: Context<MintEdition>) -> Result<()> {
        mint_nft_internal(ctx, true)
    }

    /// Update pricing (only authority)
    pub fn update_pricing(
        ctx: Context<UpdateConfig>,
        new_regular_price: Option<u64>,
        new_discounted_price: Option<u64>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        if let Some(price) = new_regular_price {
            config.mint_price = price;
            msg!("Updated regular price to: {} lamports", price);
        }
        
        if let Some(price) = new_discounted_price {
            config.discounted_price = price;
            msg!("Updated discounted price to: {} lamports", price);
        }
        
        Ok(())
    }

    /// Withdraw collected funds (only authority)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let seeds = &[
            b"payment_vault".as_ref(),
            &[ctx.bumps.payment_vault],
        ];
        let signer = &[&seeds[..]];
        
        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.payment_vault.key,
                ctx.accounts.authority.key,
                amount,
            ),
            &[
                ctx.accounts.payment_vault.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
        
        msg!("Withdrawn {} lamports to authority", amount);
        
        Ok(())
    }
}

/// Internal helper function to mint NFT with price selection
fn mint_nft_internal(ctx: Context<MintEdition>, is_discounted: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    
    // Select price based on mint type
    let price = if is_discounted {
        config.discounted_price
    } else {
        config.mint_price
    };
    
    // Transfer payment to vault
    let transfer_ix = system_instruction::transfer(
        &ctx.accounts.minter.key(),
        &ctx.accounts.payment_vault.key(),
        price,
    );
    
    invoke(
        &transfer_ix,
        &[
            ctx.accounts.minter.to_account_info(),
            ctx.accounts.payment_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Increment edition counter
    config.total_minted += 1;
    let edition_number = config.total_minted;

    let mint_type = if is_discounted { "DISCOUNTED" } else { "REGULAR" };
    msg!("Minting {} edition #{} for {}", mint_type, edition_number, ctx.accounts.minter.key());
    msg!("Payment of {} lamports received", price);

    // Create mint account
    let mint_rent = Rent::get()?.minimum_balance(82);
    invoke(
        &system_instruction::create_account(
            ctx.accounts.minter.key,
            ctx.accounts.edition_mint.key,
            mint_rent,
            82,
            &anchor_spl::token::ID,
        ),
        &[
            ctx.accounts.minter.to_account_info(),
            ctx.accounts.edition_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Initialize mint
    invoke(
        &spl_token::instruction::initialize_mint(
            &anchor_spl::token::ID,
            ctx.accounts.edition_mint.key,
            ctx.accounts.minter.key,
            Some(ctx.accounts.minter.key),
            0,
        )?,
        &[
            ctx.accounts.edition_mint.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
    )?;

    // Create associated token account
    invoke(
        &spl_associated_token_account::instruction::create_associated_token_account(
            ctx.accounts.minter.key,
            ctx.accounts.minter.key,
            ctx.accounts.edition_mint.key,
            &anchor_spl::token::ID,
        ),
        &[
            ctx.accounts.minter.to_account_info(),
            ctx.accounts.edition_token_account.to_account_info(),
            ctx.accounts.minter.to_account_info(),
            ctx.accounts.edition_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    // Mint 1 token
    invoke(
        &spl_token::instruction::mint_to(
            &anchor_spl::token::ID,
            ctx.accounts.edition_mint.key,
            ctx.accounts.edition_token_account.key,
            ctx.accounts.minter.key,
            &[],
            1,
        )?,
        &[
            ctx.accounts.edition_mint.to_account_info(),
            ctx.accounts.edition_token_account.to_account_info(),
            ctx.accounts.minter.to_account_info(),
        ],
    )?;

    // Create metadata account with collection reference
    let metadata_infos = vec![
        ctx.accounts.edition_metadata.to_account_info(),
        ctx.accounts.edition_mint.to_account_info(),
        ctx.accounts.minter.to_account_info(),
        ctx.accounts.minter.to_account_info(),
        ctx.accounts.minter.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
    ];

    let creators = vec![Creator {
        address: ctx.accounts.minter.key(),
        verified: true,
        share: 100,
    }];

    let collection = Some(Collection {
        verified: false,
        key: config.master_mint,
    });

    invoke(
        &mpl_token_metadata::instructions::CreateMetadataAccountV3 {
            metadata: ctx.accounts.edition_metadata.key(),
            mint: ctx.accounts.edition_mint.key(),
            mint_authority: ctx.accounts.minter.key(),
            payer: ctx.accounts.minter.key(),
            update_authority: (ctx.accounts.minter.key(), true),
            system_program: ctx.accounts.system_program.key(),
            rent: Some(ctx.accounts.rent.key()),
        }
        .instruction(mpl_token_metadata::instructions::CreateMetadataAccountV3InstructionArgs {
            data: DataV2 {
                name: format!("AMMo Founder #{}", edition_number),
                symbol: "FAMMo".to_string(),
                uri: "https://plum-imperial-swordfish-193.mypinata.cloud/ipfs/bafkreiddegzxdo2h3sliwjfpp22f46mfwb7frb3aibdqtln74uiiv3wkmy".to_string(),
                seller_fee_basis_points: 500,
                creators: Some(creators),
                collection,
                uses: None,
            },
            is_mutable: true,
            collection_details: None,
        }),
        metadata_infos.as_slice(),
    )?;

    // Create master edition
    let master_edition_infos = vec![
        ctx.accounts.edition.to_account_info(),
        ctx.accounts.edition_mint.to_account_info(),
        ctx.accounts.minter.to_account_info(),
        ctx.accounts.minter.to_account_info(),
        ctx.accounts.edition_metadata.to_account_info(),
        ctx.accounts.token_metadata_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
    ];

    invoke(
        &mpl_token_metadata::instructions::CreateMasterEditionV3 {
            edition: ctx.accounts.edition.key(),
            mint: ctx.accounts.edition_mint.key(),
            update_authority: ctx.accounts.minter.key(),
            mint_authority: ctx.accounts.minter.key(),
            payer: ctx.accounts.minter.key(),
            metadata: ctx.accounts.edition_metadata.key(),
            token_program: ctx.accounts.token_program.key(),
            system_program: ctx.accounts.system_program.key(),
            rent: Some(ctx.accounts.rent.key()),
        }
        .instruction(mpl_token_metadata::instructions::CreateMasterEditionV3InstructionArgs {
            max_supply: Some(0),
        }),
        master_edition_infos.as_slice(),
    )?;

    msg!("NFT successfully minted!");
    
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: Payment vault PDA
    #[account(
        seeds = [b"payment_vault"],
        bump
    )]
    pub payment_vault: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintEdition<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub minter: Signer<'info>,
    
    /// CHECK: Payment vault PDA
    #[account(
        mut,
        seeds = [b"payment_vault"],
        bump
    )]
    pub payment_vault: AccountInfo<'info>,
    
    /// CHECK: Master mint from config
    pub master_mint: AccountInfo<'info>,
    
    /// CHECK: Master edition account
    pub master_edition: AccountInfo<'info>,
    
    /// CHECK: Master metadata account
    pub master_metadata: AccountInfo<'info>,
    
    /// CHECK: New edition mint account
    #[account(mut, signer)]
    pub edition_mint: Signer<'info>,
    
    /// CHECK: Edition token account for minter
    #[account(mut)]
    pub edition_token_account: AccountInfo<'info>,
    
    /// CHECK: Edition metadata account
    #[account(mut)]
    pub edition_metadata: AccountInfo<'info>,
    
    /// CHECK: Edition account
    #[account(mut)]
    pub edition: AccountInfo<'info>,
    
    /// CHECK: Token Metadata Program
    #[account(address = TOKEN_METADATA_PROGRAM_ID)]
    pub token_metadata_program: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump,
        has_one = authority
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"config"],
        bump,
        has_one = authority
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: Payment vault PDA
    #[account(
        mut,
        seeds = [b"payment_vault"],
        bump
    )]
    pub payment_vault: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub master_mint: Pubkey,
    pub mint_price: u64,
    pub discounted_price: u64,
    pub total_minted: u64,
    pub payment_vault: Pubkey,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid master mint")]
    InvalidMasterMint,
    #[msg("Insufficient payment")]
    InsufficientPayment,
}