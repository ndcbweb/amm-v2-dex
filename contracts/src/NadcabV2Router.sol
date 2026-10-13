// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {INadcabV2Factory, INadcabV2Pair, IERC20Minimal, IWrappedNative} from "./interfaces/INadcabV2.sol";
import {NadcabV2Library} from "./libraries/NadcabV2Library.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/// @notice Uniswap V2 Router02 interface and behaviour; "ETH" in function names means the chain's native coin.
contract NadcabV2Router {
    address public immutable factory;
    address public immutable WETH;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "NadcabV2Router: EXPIRED");
        _;
    }

    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH = _WETH;
    }

    receive() external payable {
        require(msg.sender == WETH, "NadcabV2Router: NOT_WETH");
    }

    /* ---------- liquidity ---------- */

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal returns (uint256 amountA, uint256 amountB) {
        if (INadcabV2Factory(factory).getPair(tokenA, tokenB) == address(0)) {
            INadcabV2Factory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = NadcabV2Library.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = NadcabV2Library.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "NadcabV2Router: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = NadcabV2Library.quote(amountBDesired, reserveB, reserveA);
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "NadcabV2Router: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = NadcabV2Library.pairFor(factory, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = INadcabV2Pair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (amountToken, amountETH) =
            _addLiquidity(token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);
        address pair = NadcabV2Library.pairFor(factory, token, WETH);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWrappedNative(WETH).deposit{value: amountETH}();
        assert(IWrappedNative(WETH).transfer(pair, amountETH));
        liquidity = INadcabV2Pair(pair).mint(to);
        if (msg.value > amountETH) TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = NadcabV2Library.pairFor(factory, tokenA, tokenB);
        INadcabV2Pair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = INadcabV2Pair(pair).burn(to);
        (address token0,) = NadcabV2Library.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "NadcabV2Router: INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "NadcabV2Router: INSUFFICIENT_B_AMOUNT");
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        (amountToken, amountETH) =
            removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
        TransferHelper.safeTransfer(token, to, amountToken);
        IWrappedNative(WETH).withdraw(amountETH);
        TransferHelper.safeTransferETH(to, amountETH);
    }

    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = NadcabV2Library.pairFor(factory, tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        INadcabV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountToken, uint256 amountETH) {
        address pair = NadcabV2Library.pairFor(factory, token, WETH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        INadcabV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountToken, amountETH) = removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }

    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountETH) {
        (, amountETH) = removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
        TransferHelper.safeTransfer(token, to, IERC20Minimal(token).balanceOf(address(this)));
        IWrappedNative(WETH).withdraw(amountETH);
        TransferHelper.safeTransferETH(to, amountETH);
    }

    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountETH) {
        address pair = NadcabV2Library.pairFor(factory, token, WETH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        INadcabV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        amountETH = removeLiquidityETHSupportingFeeOnTransferTokens(
            token, liquidity, amountTokenMin, amountETHMin, to, deadline
        );
    }

    /* ---------- swaps ---------- */

    /// @dev Requires the initial amount to have already been sent to the first pair.
    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = NadcabV2Library.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? NadcabV2Library.pairFor(factory, output, path[i + 2]) : _to;
            INadcabV2Pair(NadcabV2Library.pairFor(factory, input, output)).swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = NadcabV2Library.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = NadcabV2Library.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "NadcabV2Router: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WETH, "NadcabV2Router: INVALID_PATH");
        amounts = NadcabV2Library.getAmountsOut(factory, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IWrappedNative(WETH).deposit{value: amounts[0]}();
        assert(IWrappedNative(WETH).transfer(NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, "NadcabV2Router: INVALID_PATH");
        amounts = NadcabV2Library.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "NadcabV2Router: EXCESSIVE_INPUT_AMOUNT");
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWrappedNative(WETH).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferETH(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, "NadcabV2Router: INVALID_PATH");
        amounts = NadcabV2Library.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWrappedNative(WETH).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferETH(to, amounts[amounts.length - 1]);
    }

    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WETH, "NadcabV2Router: INVALID_PATH");
        amounts = NadcabV2Library.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= msg.value, "NadcabV2Router: EXCESSIVE_INPUT_AMOUNT");
        IWrappedNative(WETH).deposit{value: amounts[0]}();
        assert(IWrappedNative(WETH).transfer(NadcabV2Library.pairFor(factory, path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
        if (msg.value > amounts[0]) TransferHelper.safeTransferETH(msg.sender, msg.value - amounts[0]);
    }

    /// @dev Fee-on-transfer variant: amounts come from actual pair balances.
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        uint256 feeBps = INadcabV2Factory(factory).swapFeeBps();
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = NadcabV2Library.sortTokens(input, output);
            INadcabV2Pair pair = INadcabV2Pair(NadcabV2Library.pairFor(factory, input, output));
            uint256 amountInput;
            uint256 amountOutput;
            {
                (uint256 reserve0, uint256 reserve1,) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) =
                    input == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
                amountInput = IERC20Minimal(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = NadcabV2Library.getAmountOut(amountInput, reserveInput, reserveOutput, feeBps);
            }
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? NadcabV2Library.pairFor(factory, output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amountIn);
        uint256 balanceBefore = IERC20Minimal(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20Minimal(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) {
        require(path[0] == WETH, "NadcabV2Router: INVALID_PATH");
        uint256 amountIn = msg.value;
        IWrappedNative(WETH).deposit{value: amountIn}();
        assert(IWrappedNative(WETH).transfer(NadcabV2Library.pairFor(factory, path[0], path[1]), amountIn));
        uint256 balanceBefore = IERC20Minimal(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20Minimal(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path[path.length - 1] == WETH, "NadcabV2Router: INVALID_PATH");
        TransferHelper.safeTransferFrom(path[0], msg.sender, NadcabV2Library.pairFor(factory, path[0], path[1]), amountIn);
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IERC20Minimal(WETH).balanceOf(address(this));
        require(amountOut >= amountOutMin, "NadcabV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IWrappedNative(WETH).withdraw(amountOut);
        TransferHelper.safeTransferETH(to, amountOut);
    }

    /* ---------- quotes ---------- */

    function swapFeeBps() external view returns (uint256) {
        return INadcabV2Factory(factory).swapFeeBps();
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB) {
        return NadcabV2Library.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        view
        returns (uint256 amountOut)
    {
        return NadcabV2Library.getAmountOut(amountIn, reserveIn, reserveOut, INadcabV2Factory(factory).swapFeeBps());
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        view
        returns (uint256 amountIn)
    {
        return NadcabV2Library.getAmountIn(amountOut, reserveIn, reserveOut, INadcabV2Factory(factory).swapFeeBps());
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        return NadcabV2Library.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts) {
        return NadcabV2Library.getAmountsIn(factory, amountOut, path);
    }
}
