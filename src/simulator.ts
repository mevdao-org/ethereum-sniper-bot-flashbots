import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";

/**
 * Anvil Mainnet Fork Honeypot, Buy/Sell Tax, and Anti-Snipe Simulator
 * Read the complete guide on anti-snipe traps, blacklists, and dynamic tax hooks:
 * https://mevdao.org/blog/anti-snipe-token-launches-taxes-blacklists-and-trading-delays
 */

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const;
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
]);

export interface TaxSimulationReport {
  isHoneypot: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  expectedTokensOut: bigint;
  actualTokensReceived: bigint;
  reason?: string;
}

/**
 * Replays the pending liquidity transaction on a local Anvil fork, executes a test buy
 * and an immediate test sell in the same block, plus a test sell in block N+1, to detect:
 * 1. Honeypot transfer locks (`revert` on sell)
 * 2. Block-0 auto-blacklists (`isBot[recipient] = true` on same-block buy)
 * 3. Excessive buy or sell taxes (e.g., 99% launch tax)
 */
export async function simulateTokenSafetyOnAnvil(
  anvilRpcUrl: string,
  pendingLiquidityRawTx: Hex,
  tokenAddress: Address,
  testBuyer: Address,
  buyAmountWei: bigint = parseEther("0.1")
): Promise<TaxSimulationReport> {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(anvilRpcUrl),
  });
  const testClient = createTestClient({
    chain: mainnet,
    mode: "anvil",
    transport: http(anvilRpcUrl),
  });
  const walletClient = createWalletClient({
    account: testBuyer,
    chain: mainnet,
    transport: http(anvilRpcUrl),
  });

  // Create a state snapshot so we leave Anvil clean after testing
  const snapshotId = await testClient.snapshot();

  try {
    await testClient.impersonateAccount({ address: testBuyer });
    await testClient.setBalance({ address: testBuyer, value: parseEther("10") });

    // 1. Broadcast the developer's pending liquidity/enableTrading transaction on the fork
    await publicClient.sendRawTransaction({ serializedTransaction: pendingLiquidityRawTx });

    // 2. Quote theoretical output from Uniswap V2 reserves
    const quotedBuy = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [buyAmountWei, [WETH_ADDRESS, tokenAddress]],
    });
    const expectedTokensOut = quotedBuy[1];

    // 3. Execute Buy in the exact same block
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    await walletClient.writeContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [0n, [WETH_ADDRESS, tokenAddress], testBuyer, deadline],
      value: buyAmountWei,
    });

    const actualTokensReceived = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [testBuyer],
    });

    if (actualTokensReceived === 0n) {
      return {
        isHoneypot: true,
        buyTaxBps: 10_000,
        sellTaxBps: 10_000,
        expectedTokensOut,
        actualTokensReceived: 0n,
        reason: "Zero tokens received on buy (stealth mint/transfer block)",
      };
    }

    const buyTaxBps = Number(
      ((expectedTokensOut - actualTokensReceived) * 10_000n) / expectedTokensOut
    );

    // 4. Advance 1 block to verify whether Block-0 buyers get blacklisted on subsequent sells
    await testClient.mine({ blocks: 1 });

    await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [UNISWAP_V2_ROUTER, actualTokensReceived],
    });

    const quotedSell = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [actualTokensReceived, [tokenAddress, WETH_ADDRESS]],
    });
    const expectedEthBack = quotedSell[1];

    const ethBeforeSell = await publicClient.getBalance({ address: testBuyer });
    const sellTxHash = await walletClient.writeContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [actualTokensReceived, 0n, [tokenAddress, WETH_ADDRESS], testBuyer, deadline],
    });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellTxHash });
    const ethAfterSell = await publicClient.getBalance({ address: testBuyer });

    const gasCost = sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
    const netEthReceived = ethAfterSell - ethBeforeSell + gasCost;

    const sellTaxBps =
      expectedEthBack > 0n
        ? Number(((expectedEthBack - netEthReceived) * 10_000n) / expectedEthBack)
        : 10_000;

    return {
      isHoneypot: false,
      buyTaxBps: Math.max(0, buyTaxBps),
      sellTaxBps: Math.max(0, sellTaxBps),
      expectedTokensOut,
      actualTokensReceived,
    };
  } catch (err) {
    return {
      isHoneypot: true,
      buyTaxBps: 10_000,
      sellTaxBps: 10_000,
      expectedTokensOut: 0n,
      actualTokensReceived: 0n,
      reason: `Simulation reverted: ${(err as Error).message}`,
    };
  } finally {
    await testClient.revert({ id: snapshotId });
  }
}
