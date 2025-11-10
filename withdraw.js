const { 
  Connection, 
  PublicKey, 
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction
} = require("@solana/web3.js");
const fs = require("fs");
const BN = require("bn.js");
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function for user confirmation
function askQuestion(query) {
  return new Promise(resolve => readline.question(query, ans => {
    readline.close();
    resolve(ans.toLowerCase() === 'y');
  }));
}

// Load program config
let config;
try {
  config = JSON.parse(fs.readFileSync("program-config.json"));
} catch (error) {
  console.error("❌ Error loading config file:", error.message);
  process.exit(1);
}

const PROGRAM_ID = new PublicKey(config.programId);
const CONFIG_PDA = new PublicKey(config.configPda);
const PAYMENT_VAULT_PDA = new PublicKey(config.paymentVaultPda);

// Mainnet RPC - using Helius for reliability
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=68c492db-d1ed-4e79-97a4-47a4dd6945b3";

async function withdraw(amountInLamports = null) {
  let connection;
  try {
    // Connect to mainnet via Helius RPC
    console.log("🔌 Connecting to Solana mainnet...");
    connection = new Connection(RPC_ENDPOINT, "confirmed");
    
    // Load wallet (authority)
    const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
    let wallet;
    try {
      const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
      wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    } catch (error) {
      throw new Error(`Failed to load wallet: ${error.message}`);
    }
    
    console.log("\n📋 Program Details:");
    console.log("  Program ID:", PROGRAM_ID.toString());
    console.log("  Authority:", wallet.publicKey.toString());
    console.log("  Config PDA:", CONFIG_PDA.toString());
    console.log("  Payment Vault:", PAYMENT_VAULT_PDA.toString());

    // Get vault balance
    const vaultBalance = await connection.getBalance(PAYMENT_VAULT_PDA);
    if (vaultBalance === 0) {
      throw new Error("Vault balance is 0. Nothing to withdraw.");
    }
    
    console.log("\n💰 Vault Balance:", (vaultBalance / 1_000_000_000).toFixed(9), "SOL");

    let withdrawAmount = amountInLamports;
    if (withdrawAmount === null) {
      withdrawAmount = vaultBalance; // Withdraw all by default
    } else if (withdrawAmount > vaultBalance) {
      throw new Error(`Requested amount (${withdrawAmount} lamports) exceeds vault balance (${vaultBalance} lamports)`);
    }
    
    // Convert lamports to SOL for display
    const solAmount = withdrawAmount / 1_000_000_000;
    
    // Ask for confirmation for large withdrawals
    if (solAmount >= 1) { // 1 SOL or more
      console.log(`\n⚠️  WARNING: You are about to withdraw ${solAmount.toFixed(9)} SOL`);
      const confirm = await askQuestion("Are you sure you want to continue? (y/n): ");
      if (!confirm) {
        console.log("Withdrawal cancelled by user.");
        return;
      }
    }

    console.log(`\n💸 Withdrawing ${solAmount.toFixed(9)} SOL (${withdrawAmount} lamports)...`);

    // Create instruction data
    // Discriminator (8 bytes) + amount (8 bytes)
    const discriminator = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]); // Correct "withdraw" discriminator (sha256("global:withdraw")[0:8])
    const amountBuffer = new BN(withdrawAmount).toArrayLike(Buffer, "le", 8);
    const data = Buffer.concat([discriminator, amountBuffer]);

    // Create withdraw instruction
    const withdrawIx = new TransactionInstruction({
      keys: [
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: PAYMENT_VAULT_PDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: data,
    });

    // Create and send transaction with better error handling
    let signature;
    try {
      console.log("\n⏳ Sending transaction...");
      const tx = new Transaction().add(withdrawIx);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = wallet.publicKey;
      
      // Sign and send
      signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [wallet],
        {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 5
        }
      );

      // Wait for confirmation
      console.log("\n⏳ Waiting for confirmation...");
      const confirmation = await connection.confirmTransaction(
        signature,
        'confirmed'
      );
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      console.log("\n✅ Withdrawal successful!");
      console.log("  Transaction signature:", signature);
      console.log(`  View on explorer: https://explorer.solana.com/tx/${signature}?cluster=mainnet`);
      
      // Show new vault balance
      const newBalance = await connection.getBalance(PAYMENT_VAULT_PDA);
      console.log(`\n💰 New Vault Balance: ${(newBalance / 1_000_000_000).toFixed(9)} SOL`);
      
    } catch (txError) {
      console.error("\n❌ Transaction failed:", txError.message);
      if (signature) {
        console.log(`  Failed transaction: https://explorer.solana.com/tx/${signature}?cluster=mainnet`);
      }
      throw txError;
    }

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    
    // Check if it's a rate limit error
    if (error.message.includes("429") || error.message.includes("too many requests")) {
      console.log("\n⚠️  Rate limited by RPC. Please wait a moment and try again.");
    }
    
    // Show program logs if available
    if (error.logs && error.logs.length > 0) {
      console.error("\n📝 Program logs:");
      error.logs.forEach(log => console.error(`  ${log}`));
    }
    
    process.exit(1);
  } finally {
    if (readline) {
      readline.close();
    }
  }
}

// Main execution
(async () => {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let amount = null;
    
    if (args.length > 0) {
      const input = args[0];
      if (isNaN(input)) {
        console.error("❌ Error: Amount must be a number in lamports");
        process.exit(1);
      }
      amount = parseInt(input);
      if (amount <= 0) {
        console.error("❌ Error: Amount must be greater than 0");
        process.exit(1);
      }
    }
    
    await withdraw(amount);
  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    process.exit(1);
  }
})();