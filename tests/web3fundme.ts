import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DonationMatching } from "../target/types/donation_matching";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("donation_matching", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .DonationMatching as Program<DonationMatching>;
  const admin = provider.wallet;

  let usdcMint: anchor.web3.PublicKey;
  let platformPda: anchor.web3.PublicKey;
  let platformBump: number;
  let creator: anchor.web3.Keypair;

  before(async () => {
    usdcMint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6
    );
    [platformPda, platformBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("platform")],
      program.programId
    );
  });

  it("Initialize platform", async () => {
    await program.methods
      .initializePlatform()
      .accounts({
        platform: platformPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const platform = await program.account.platform.fetch(platformPda);
    assert.equal(platform.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(platform.feePercentage, 250);
  });

  it("Create a campaign", async () => {
    creator = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(creator.publicKey, 2e9)
    );

    const creatorToken = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      creator.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      creatorToken,
      admin.publicKey,
      1_000_000_000
    );

    const totalCampaigns = (
      await program.account.platform.fetch(platformPda)
    ).totalCampaigns.toNumber();
    const [campaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(totalCampaigns).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );
    const [vaultAuthPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), campaignPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createCampaign(
        new anchor.BN(500_000_000),
        new anchor.BN(200_000_000),
        new anchor.BN(600),
        "Tree Plantation",
        "Plant 10,000 trees worldwide",
        100,
        creator.publicKey
      )
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        vaultAuth: vaultAuthPda,
        platform: platformPda,
        creator: creator.publicKey,
        creatorTokenAccount: creatorToken,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaign.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(campaign.matchingRatio, 100);
    assert.isTrue(campaign.isActive);
  });

  it("Donate and verify matching contribution", async () => {
    const donor = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(donor.publicKey, 2e9)
    );
    const donorToken = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      donor.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      donorToken,
      admin.publicKey,
      500_000_000
    );

    const platform = await program.account.platform.fetch(platformPda);
    const [campaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(platform.totalCampaigns - 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );

    const campaignBefore = await program.account.campaign.fetch(campaignPda);
    const totalDonors = campaignBefore.totalDonors;
    const [donationPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("donation"),
        campaignPda.toBuffer(),
        donor.publicKey.toBuffer(),
        new anchor.BN(totalDonors).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .donate(new anchor.BN(100_000_000))
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        donation: donationPda,
        platform: platformPda,
        donor: donor.publicKey,
        donorTokenAccount: donorToken,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc();

    const donation = await program.account.donation.fetch(donationPda);
    assert.equal(donation.amount.toString(), "100000000");
    assert.equal(donation.matchingAmount.toString(), "100000000");

    const campaignAfter = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaignAfter.totalDonors, totalDonors + 1);
    assert.isTrue(campaignAfter.raisedAmount.gte(new anchor.BN(200_000_000)));
  });

  it("Add more matching funds to campaign", async () => {
    const matcher = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(matcher.publicKey, 2e9)
    );
    const matcherToken = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      matcher.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      matcherToken,
      admin.publicKey,
      1_000_000_000
    );

    const platform = await program.account.platform.fetch(platformPda);
    const [campaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(platform.totalCampaigns - 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );

    const before = await program.account.campaign.fetch(campaignPda);
    await program.methods
      .addMatchingFunds(new anchor.BN(50_000_000))
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        matcher: matcher.publicKey,
        matcherTokenAccount: matcherToken,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([matcher])
      .rpc();

    const after = await program.account.campaign.fetch(campaignPda);
    assert.ok(after.matchingPoolTotal.gt(before.matchingPoolTotal));
  });

  it("Withdraw funds after goal reached", async () => {
    const platform = await program.account.platform.fetch(platformPda);
    const [campaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(platform.totalCampaigns - 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );
    const [vaultAuthPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), campaignPda.toBuffer()],
      program.programId
    );

    const beneficiaryToken = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      creator.publicKey
    );

    const platformFeeAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      admin.publicKey
    );

    await program.methods
      .withdrawFunds()
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        vaultAuth: vaultAuthPda,
        platform: platformPda,
        beneficiary: creator.publicKey,
        beneficiaryTokenAccount: beneficiaryToken.address,
        platformFeeAccount: platformFeeAccount.address,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([creator]) // ✅ Added signer
      .rpc();

    const vault = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vault.amount), 0);
  });

  it("Admin can emergency pause campaign", async () => {
    const platform = await program.account.platform.fetch(platformPda);
    const [campaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(platform.totalCampaigns - 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .emergencyPauseCampaign()
      .accounts({
        campaign: campaignPda,
        platform: platformPda,
        admin: admin.publicKey,
      })
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.isFalse(campaign.isActive);
  });

  it("Reject invalid donation amount (0)", async () => {
    // 🆕 Create a fresh campaign for invalid donation test
    const invalidCreator = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(invalidCreator.publicKey, 2e9);
    const invalidCreatorToken = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      invalidCreator.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      invalidCreatorToken,
      admin.publicKey,
      500_000_000
    );

    const platformData = await program.account.platform.fetch(platformPda);
    const [newCampaignPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        new anchor.BN(platformData.totalCampaigns).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [newVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newCampaignPda.toBuffer()],
      program.programId
    );
    const [newVaultAuthPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), newCampaignPda.toBuffer()],
      program.programId
    );

    await program.methods
      .createCampaign(
        new anchor.BN(100_000_000),
        new anchor.BN(50_000_000),
        new anchor.BN(500),
        "Invalid Test",
        "For invalid donation testing",
        100,
        invalidCreator.publicKey
      )
      .accounts({
        campaign: newCampaignPda,
        campaignVault: newVaultPda,
        vaultAuth: newVaultAuthPda,
        platform: platformPda,
        creator: invalidCreator.publicKey,
        creatorTokenAccount: invalidCreatorToken,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([invalidCreator])
      .rpc();

    // ❌ Now donate with 0 amount
    const donor = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(donor.publicKey, 2e9);
    const donorToken = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      donor.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      donorToken,
      admin.publicKey,
      100_000_000
    );

    const [donationPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("donation"),
        newCampaignPda.toBuffer(),
        donor.publicKey.toBuffer(),
        new anchor.BN(0).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    try {
      await program.methods
        .donate(new anchor.BN(0))
        .accounts({
          campaign: newCampaignPda,
          campaignVault: newVaultPda,
          donation: donationPda,
          platform: platformPda,
          donor: donor.publicKey,
          donorTokenAccount: donorToken,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([donor])
        .rpc();
      assert.fail("Should have thrown InvalidDonationAmount");
    } catch (err) {
      const msg = err.error?.errorMessage || err.toString();
      assert.include(msg, "Invalid donation amount");
    }
  });
});
