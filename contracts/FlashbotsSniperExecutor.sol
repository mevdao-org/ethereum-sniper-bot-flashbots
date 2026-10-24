// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FlashbotsSniperExecutor
 * @author MEV DAO (https://mevdao.org)
 * @notice Atomic Block-0 Uniswap V2 Sniper & Builder Bribe Executor.
 *         Executes an exact ETH->Token swap, verifies actual post-tax tokens received
 *         against minimum thresholds, and pays the block builder via block.coinbase
 *         ONLY if the swap succeeds and meets anti-honeypot invariants.
 *
 *         Full architectural guide:
 *         https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
 */

interface IUniswapV2Router02 {
    function WETH() external pure returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract FlashbotsSniperExecutor {
    address public immutable owner;
    IUniswapV2Router02 public immutable router;
    address public immutable WETH;

    error Unauthorized();
    error InsufficientOutputPostTax(uint256 expectedMin, uint256 actualReceived);
    error CoinbaseBribeFailed();

    constructor(address _router) {
        owner = msg.sender;
        router = IUniswapV2Router02(_router);
        WETH = IUniswapV2Router02(_router).WETH();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /**
     * @notice Executes an atomic Uniswap V2 buy and pays block.coinbase bribe conditionally.
     * @param token Target ERC-20 token address being launched
     * @param swapAmountWei Exact ETH amount to swap into the pool
     * @param bribeAmountWei Exact ETH amount to pay block.coinbase (builder tip)
     * @param maxTaxBps Maximum acceptable buy tax + slippage in basis points (e.g. 1000 = 10%)
     * @param recipient Wallet to receive the purchased tokens
     */
    function snipeWithCoinbaseBribe(
        address token,
        uint256 swapAmountWei,
        uint256 bribeAmountWei,
        uint256 maxTaxBps,
        address recipient
    ) external payable onlyOwner {
        require(msg.value >= swapAmountWei + bribeAmountWei, "Insufficient msg.value");

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = token;

        // Query theoretical output from reserves right after the dev's addLiquidityETH tx
        uint256[] memory expectedAmounts = router.getAmountsOut(swapAmountWei, path);
        uint256 minAcceptableOut = (expectedAmounts[1] * (10_000 - maxTaxBps)) / 10_000;

        uint256 balanceBefore = IERC20(token).balanceOf(recipient);

        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: swapAmountWei}(
            minAcceptableOut,
            path,
            recipient,
            block.timestamp
        );

        uint256 actualReceived = IERC20(token).balanceOf(recipient) - balanceBefore;
        if (actualReceived < minAcceptableOut) {
            revert InsufficientOutputPostTax(minAcceptableOut, actualReceived);
        }

        // Pay the block builder directly via coinbase transfer only if the buy succeeded
        if (bribeAmountWei > 0) {
            (bool ok, ) = block.coinbase.call{value: bribeAmountWei}("");
            if (!ok) revert CoinbaseBribeFailed();
        }
    }

    function rescueETH() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "ETH rescue failed");
    }

    function rescueERC20(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, bal);
    }

    receive() external payable {}
}
