import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DonationMatching } from "../target/types/donation_matching";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("donation_matching", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .DonationMatching as Program<DonationMatching>;
  const admin = provider.wallet;
  let usdcMint: anchor.web3.PublicKey;

  // PDAs
  let platformPda: anchor.web3.PublicKey;
  let platformBump: number;

  before(async () => {
    // Create a fake USDC mint
    usdcMint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6 // decimals
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

  it("Create campaign", async () => {
    const creator = anchor.web3.Keypair.generate();

    // Fund creator with SOL
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(creator.publicKey, 2e9)
    );

    // Create creator token account & mint tokens
    const creatorTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      creator.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      creatorTokenAccount,
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
        new anchor.BN(500_000_000), // goal
        new anchor.BN(200_000_000), // matching pool
        new anchor.BN(3600), // duration
        "Save the Earth",
        "A donation campaign for environmental efforts",
        100, // 1:1 matching
        creator.publicKey
      )
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        vaultAuth: vaultAuthPda,
        platform: platformPda,
        creator: creator.publicKey,
        creatorTokenAccount,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaign.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(campaign.goalAmount.toString(), "500000000");
    assert.equal(campaign.matchingRatio, 100);
  });

  it("Donate with matching", async () => {
    const donor = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(donor.publicKey, 2e9)
    );

    const donorTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      donor.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      donorTokenAccount,
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
    const totalDonorsBefore = campaignBefore.totalDonors;

    const [donationPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("donation"),
        campaignPda.toBuffer(),
        donor.publicKey.toBuffer(),
        new anchor.BN(totalDonorsBefore).toArrayLike(Buffer, "le", 4),
      ],
      program.programId
    );

    await program.methods
      .donate(new anchor.BN(100_000_000)) // 100 USDC
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        donation: donationPda,
        platform: platformPda,
        donor: donor.publicKey,
        donorTokenAccount,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc();

    const donation = await program.account.donation.fetch(donationPda);
    assert.equal(donation.amount.toString(), "100000000");
    assert.equal(donation.matchingAmount.toString(), "100000000"); // 1:1 matching
  });

  it("Add matching funds", async () => {
    const matcher = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(matcher.publicKey, 2e9)
    );

    const matcherTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      usdcMint,
      matcher.publicKey
    );
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      matcherTokenAccount,
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

    await program.methods
      .addMatchingFunds(new anchor.BN(100_000_000))
      .accounts({
        campaign: campaignPda,
        campaignVault: vaultPda,
        matcher: matcher.publicKey,
        matcherTokenAccount,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([matcher])
      .rpc();

    const updatedCampaign = await program.account.campaign.fetch(campaignPda);
    assert.ok(
      updatedCampaign.matchingPoolTotal.gte(new anchor.BN(300_000_000))
    );
  });

  it("Emergency pause by admin", async () => {
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

    const updatedCampaign = await program.account.campaign.fetch(campaignPda);
    assert.isFalse(updatedCampaign.isActive);
  });
});
