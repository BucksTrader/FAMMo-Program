const { 
  Connection, 
  PublicKey, 
  SystemProgram, 
  Keypair,
  Transaction,
  TransactionInstruction 
} = require("@solana/web3.js");
const fs = require("fs");
const crypto = require("crypto");

// Load your master NFT info - UPDATE THIS PATH if needed
const masterInfo = JSON.parse(fs.readFileSync("../nft-master-setup/collection-master-info.json"));

const PROGRAM_ID = new PublicKey("C4FiFWofsjxRGXrcF5i1RnxPHc7QDcSf9XzhFgLQyioh");

// Helper function to generate discriminator from function name
function getDiscriminator(name) {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

async function initialize() {
  try {
    // Connect to mainnet via Helius RPC
    const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=68c492db-d1ed-4e79-97a4-47a4dd6945b3", "confirmed");
    
    // Load wallet
    const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
    const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    
    console.log("Program ID:", PROGRAM_ID.toString());
    console.log("Authority:", wallet.publicKey.toString());
    console.log("Master Mint:", masterInfo.masterMint || masterInfo.collectionMint);

    // Derive PDAs
    const [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID
    );

    const [paymentVaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("payment_vault")],
      PROGRAM_ID
    );

    console.log("\nDerived PDAs:");
    console.log("Config PDA:", configPda.toString());
    console.log("Payment Vault PDA:", paymentVaultPda.toString());

    // Check if already initialized
    const configAccount = await connection.getAccountInfo(configPda);
    if (configAccount) {
      console.log("\n⚠️  Program already initialized!");
      console.log("Config account exists with", configAccount.data.length, "bytes");
      
      // Parse and display current config (updated structure with discounted_price)
      try {
        const authority = new PublicKey(configAccount.data.slice(8, 40));
        const masterMint = new PublicKey(configAccount.data.slice(40, 72));
        const mintPrice = configAccount.data.readBigUInt64LE(72);
        const discountedPrice = configAccount.data.readBigUInt64LE(80);
        const totalMinted = configAccount.data.readBigUInt64LE(88);
        
        console.log("\nCurrent Config:");
        console.log("  Authority:", authority.toString());
        console.log("  Master Mint:", masterMint.toString());
        console.log("  Regular Price:", (Number(mintPrice) / 1e9).toFixed(2), "SOL");
        console.log("  Discounted Price:", (Number(discountedPrice) / 1e9).toFixed(2), "SOL");
        console.log("  Total Minted:", totalMinted.toString());
      } catch (e) {
        console.log("Could not parse config data:", e.message);
      }
      
      // Save config anyway
      const config = {
        programId: PROGRAM_ID.toString(),
        configPda: configPda.toString(),
        paymentVaultPda: paymentVaultPda.toString(),
        masterMint: masterInfo.masterMint || masterInfo.collectionMint,
        masterMetadata: masterInfo.masterMetadata || masterInfo.collectionMetadata,
        masterEdition: masterInfo.masterEdition || masterInfo.collectionMasterEdition,
        mintPrice: "0.2",
        discountedPrice: "0.1",
        network: "mainnet",
      };
      fs.writeFileSync("program-config.json", JSON.stringify(config, null, 2));
      console.log("\n💾 Config saved to program-config.json");
      return;
    }

    console.log("\n🚀 Initializing program...");

    // Generate discriminator for "initialize" function
    const discriminator = getDiscriminator("initialize");
    console.log("Discriminator:", Buffer.from(discriminator).toString('hex'));
    
    const masterMintPubkey = new PublicKey(masterInfo.masterMint || masterInfo.collectionMint);
    const data = Buffer.concat([
      discriminator,
      masterMintPubkey.toBuffer()
    ]);

    // Create initialize instruction
    const initializeIx = new TransactionInstruction({
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: paymentVaultPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: data,
    });

    // Send transaction
    const tx = new Transaction().add(initializeIx);
    const signature = await connection.sendTransaction(tx, [wallet], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log("\n⏳ Confirming transaction...");
    await connection.confirmTransaction(signature, "confirmed");

    console.log("\n✅ Initialization successful!");
    console.log("Transaction signature:", signature);
    console.log(`\nView on explorer: https://explorer.solana.com/tx/${signature}?cluster=mainnet`);

    // Save config for frontend
    const config = {
      programId: PROGRAM_ID.toString(),
      configPda: configPda.toString(),
      paymentVaultPda: paymentVaultPda.toString(),
      masterMint: masterInfo.masterMint || masterInfo.collectionMint,
      masterMetadata: masterInfo.masterMetadata || masterInfo.collectionMetadata,
      masterEdition: masterInfo.masterEdition || masterInfo.collectionMasterEdition,
      mintPrice: "0.2",
      discountedPrice: "0.1",
      network: "mainnet",
    };

    fs.writeFileSync("program-config.json", JSON.stringify(config, null, 2));
    console.log("\n💾 Config saved to program-config.json");
    console.log("\n📋 Status:");
    console.log("✅ Master NFT created");
    console.log("✅ Program deployed");
    console.log("✅ Program initialized");
    console.log("💰 Regular price: 0.2 SOL (website)");
    console.log("💰 Discounted price: 0.1 SOL (dapp)");
    console.log("🚀 Ready to build frontend!");

  } catch (error) {
    console.error("\n❌ Error:", error);
    if (error.logs) {
      console.error("\nProgram logs:");
      error.logs.forEach(log => console.error(log));
    }
    throw error;
  }
}

initialize();